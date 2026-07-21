import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages project site: served under /vector.
export default defineConfig({
  site: "https://avram19.github.io",
  base: "/vector",
  integrations: [
    starlight({
      title: "Vector",
      description: "An agent-first terminal — every tab runs a coding agent.",
      logo: { src: "./src/assets/placeholders/logo.svg", replacesTitle: false },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/avram19/vector" },
      ],
      editLink: {
        baseUrl: "https://github.com/avram19/vector/edit/main/website/",
      },
      // Landing page lives at /vector (custom index.astro); docs are grouped below.
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guide", items: [{ autogenerate: { directory: "guide" } }] },
        { label: "Agents & config", items: [{ autogenerate: { directory: "agents" } }] },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
      ],
      customCss: ["./src/styles/landing.css"],
    }),
  ],
});
