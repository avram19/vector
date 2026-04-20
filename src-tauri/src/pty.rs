use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl PtyRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        program: &[String],
        env: &[(String, String)],
        cwd: Option<std::path::PathBuf>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<()> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let (cmd_name, rest) = program.split_first().ok_or_else(|| anyhow::anyhow!("empty command"))?;
        let mut cmd = CommandBuilder::new(cmd_name);
        for a in rest { cmd.arg(a); }
        if let Some(cwd) = cwd { cmd.cwd(cwd); }
        if let Ok(home) = std::env::var("HOME") { cmd.env("HOME", home); }
        if let Ok(user) = std::env::var("USER") { cmd.env("USER", user); }
        if let Ok(lang) = std::env::var("LANG") { cmd.env("LANG", lang); }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // caller-supplied env wins (includes augmented PATH)
        for (k, v) in env { cmd.env(k, v); }

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let killer = child.clone_killer();

        let session = Session { master: pair.master, writer, killer };
        let arc = Arc::new(Mutex::new(session));
        self.sessions.lock().insert(id.clone(), arc.clone());

        // reader thread
        let app_r = app.clone();
        let id_r = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_r.emit(&format!("pty-data-{id_r}"), s);
                    }
                    Err(_) => break,
                }
            }
        });

        // wait thread — owns the child outright; no shared lock.
        let app_w = app.clone();
        let id_w = id.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|st| st.exit_code() as i32).unwrap_or(-1);
            let _ = app_w.emit(&format!("pty-exit-{id_w}"), code);
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().get(id).cloned() {
            s.lock().writer.write_all(data.as_bytes())?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().get(id).cloned() {
            s.lock().master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().remove(id) {
            let _ = s.lock().killer.kill();
        }
        Ok(())
    }
}
