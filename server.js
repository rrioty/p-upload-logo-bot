const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Pons upload bot is running",
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server started on port ${port}`);
});
