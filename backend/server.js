// LightMatter backend — entry point

// 1. Bring in Express, the web framework we installed.
const express = require("express");

// 2. Bring in Node's built-in "path" module for building safe file paths.
const path = require("path");

// 3. Bring in our aurora route module (the router we built in routes/).
//    "./routes/aurora" is relative to THIS file (backend/).
const auroraRoute = require("./routes/aurora");

// 4. Create the Express application.
const app = express();

// 5. Pick a port (use the environment's PORT if set, else 3000).
const PORT = process.env.PORT || 3000;

// 6. Mount our API routes. Any request starting with "/api/aurora" is
//    handed to the aurora router. As we add more data sources, they line
//    up here: "/api/clouds", "/api/satellites", etc.
app.use("/api/aurora", auroraRoute);

// 7. Serve the frontend folder as static files. Anything not matched by an
//    API route above falls through to here (e.g. "/" -> index.html).
app.use(express.static(path.join(__dirname, "..", "frontend")));

// 8. Start listening for requests.
app.listen(PORT, () => {
  console.log(`LightMatter server running at http://localhost:${PORT}`);
});
