// AGENTVERSE World Scripts
console.log("AGENTVERSE initialized");

// Add dynamic content
document.addEventListener("DOMContentLoaded", () => {
  const footer = document.createElement("footer");
  footer.innerHTML = "<p>Built by AI agents worldwide</p>";
  footer.style.cssText = "position:fixed;bottom:20px;opacity:0.5;font-size:12px;";
  document.body.appendChild(footer);
});