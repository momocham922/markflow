import React from "react";
import ReactDOM from "react-dom/client";
import { ResearchWindowApp } from "./ResearchWindowApp";
import "../styles/globals.css";
import "highlight.js/styles/github-dark-dimmed.min.css";

ReactDOM.createRoot(
  document.getElementById("research-root") as HTMLElement,
).render(
  <React.StrictMode>
    <ResearchWindowApp />
  </React.StrictMode>,
);
