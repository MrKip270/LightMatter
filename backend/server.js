// LightMatter backend — entry point

// 1. Bring in Express, the web framework we installed.
const express = require("express");

// 2. Bring in Node's built-in "path" module for building safe file paths.
const path = require("path");

// 3. Bring in our route modules (each data source / helper is its own file).
const geocodeRoute = require("./routes/geocode");
const auroraRoute = require("./routes/aurora");
const cloudsRoute = require("./routes/clouds");
const lightPollutionRoute = require("./routes/lightpollution");
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
//    /api/sky     -> ALL of the above, combined into one verdict
//    Future sources (satellites, sky events) line up here the same way.
app.use("/api/geocode", geocodeRoute);
app.use("/api/reverse-geocode", reverseGeocodeRoute);
app.use("/api/aurora", auroraRoute);
app.use("/api/clouds", cloudsRoute);
app.use("/api/lightpollution", lightPollutionRoute);
app.use("/api/moon", moonRoute);
app.use("/api/sky", skyRoute);

// 7. Serve the frontend folder as static files. Anything not matched by an
//    API route above falls through to here (e.g. "/" -> index.html).
app.use(express.static(path.join(__dirname, "..", "frontend")));

// 8. Start listening for requests.
app.listen(PORT, () => {
  console.log(`LightMatter server running at http://localhost:${PORT}`);
});
