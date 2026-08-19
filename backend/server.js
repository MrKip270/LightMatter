// LightMatter backend — entry point

// 1. Bring in Express, the web framework we installed.
const express = require("express");

// 2. Bring in Node's built-in "path" module for building safe file paths.
const path = require("path");

// 3. Bring in our route modules (each data source / helper is its own file).
const geocodeRoute = require("./routes/geocode");
const auroraRoute = require("./routes/aurora");
const auroraTilesRoute = require("./routes/auroratiles");
const cloudsRoute = require("./routes/clouds");
const darkSiteRoute = require("./routes/darksite");
const lightPollutionRoute = require("./routes/lightpollution");
const lightPollutionTilesRoute = require("./routes/lightpollutiontiles");
const moonRoute = require("./routes/moon");
const reverseGeocodeRoute = require("./routes/reversegeocode");
const skyRoute = require("./routes/sky");

// 4. Create the Express application.
const app = express();

// 5. Pick a port (use the environment's PORT if set, else 3000).
const PORT = process.env.PORT || 3000;

// 6. Mount our API routes. Requests are matched top-to-bottom.
//    /api/geocode -> turn a place name into coordinates
//    /api/aurora  -> aurora probability for coordinates
//    /api/clouds  -> tonight's cloud cover for coordinates
//    /api/lightpollution -> sky darkness for coordinates (local dataset)
//    /api/darksite -> nearest cell in that dataset meeting a target darkness
//    /api/sky     -> ALL of the above, combined into one verdict
//    Future sources (satellites, sky events) line up here the same way.
app.use("/api/geocode", geocodeRoute);
app.use("/api/reverse-geocode", reverseGeocodeRoute);
// Mounted BEFORE /api/aurora for the same reason as the light-pollution
// tiles below: the more specific /tile path must match first, or the point
// route would try to parse "tile" as part of a coordinate query.
app.use("/api/aurora/tile", auroraTilesRoute);
app.use("/api/aurora", auroraRoute);
app.use("/api/clouds", cloudsRoute);
// Mounted BEFORE /api/lightpollution so the more specific tile paths match
// first. Express matches top to bottom, and the point-lookup route would
// otherwise swallow /tile/... as a query with no coordinates.
app.use("/api/lightpollution/tile", lightPollutionTilesRoute);
app.use("/api/lightpollution", lightPollutionRoute);
app.use("/api/darksite", darkSiteRoute);
app.use("/api/moon", moonRoute);
app.use("/api/sky", skyRoute);

// 7. Serve the frontend folder as static files. Anything not matched by an
//    API route above falls through to here (e.g. "/" -> index.html).
app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    extensions: ["html"],
  })
);

// 8. Start listening for requests — but only when this file is run directly
//    (`npm start`), not when a test require()s it to hit the real app on an
//    ephemeral port. `require.main === module` is the standard Node check
//    for "was this the entry point or just imported".
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LightMatter server running at http://localhost:${PORT}`);
  });
}
