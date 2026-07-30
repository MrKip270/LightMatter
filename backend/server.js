// LightMatter backend — entry point

// 1. Bring in Express, the web framework we installed.
const express = require("express");

// 2. Bring in Node's built-in "path" module. It builds file paths that
//    work correctly on any operating system (Mac, Windows, Linux).
const path = require("path");

// 3. Create the Express application.
const app = express();

// 4. Pick a port (use the environment's PORT if set, else 3000).
const PORT = process.env.PORT || 3000;

// 5. Serve the frontend folder as static files.
//    - __dirname is the folder THIS file lives in (backend/).
//    - path.join(__dirname, "..", "frontend") goes up one level to the
//      project root, then into frontend/ — the absolute path to our site.
//    - express.static(...) is MIDDLEWARE: for every incoming request it
//      checks that folder and, if a matching file exists, sends it back.
//      A request for "/" returns frontend/index.html automatically.
app.use(express.static(path.join(__dirname, "..", "frontend")));

// 6. Start listening for requests.
app.listen(PORT, () => {
  console.log(`LightMatter server running at http://localhost:${PORT}`);
});
