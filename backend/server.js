// LightMatter backend — entry point

// 1. Bring in Express, the web framework we installed.
//    require() loads a library and hands us back what it exports.
const express = require("express");

// 2. Create an Express application. This `app` object IS our server —
//    we'll attach routes and settings to it.
const app = express();

// 3. Pick a port (the "door number" the server listens on).
//    Use the PORT the environment gives us if there is one, else default
//    to 3000. process.env is how Node reads environment variables.
const PORT = process.env.PORT || 3000;

// 4. Define a route. This says: when a browser makes a GET request to "/"
//    (the home path), run this function.
//      - req  = the incoming request (what the browser is asking for)
//      - res  = the response (what we send back)
app.get("/", (req, res) => {
  res.send("LightMatter is alive!");
});

// 5. Start the server: begin listening for requests on our port.
//    The callback runs once, right after the server is up.
app.listen(PORT, () => {
  console.log(`LightMatter server running at http://localhost:${PORT}`);
});
