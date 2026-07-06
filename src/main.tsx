import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PrReviewView } from "./github/PrReviewView";
import "./index.css";

const prReviewParam = new URLSearchParams(location.search).get("prReview");

function PrReviewStandalone({ param }: { param: string }) {
  // `param` decodes to "owner/name/123" — repo itself contains a "/", so
  // split on the *last* "/" rather than destructuring split("/").
  const sep = param.lastIndexOf("/");
  const repo = param.slice(0, sep);
  const numberStr = param.slice(sep + 1);
  return (
    <div className="prv-standalone">
      <PrReviewView repo={repo} number={Number(numberStr)} standalone />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {prReviewParam ? <PrReviewStandalone param={prReviewParam} /> : <App />}
  </React.StrictMode>
);
