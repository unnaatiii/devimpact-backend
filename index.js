const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    console.log("HIT / route");
  res.send("Backend is running 🚀");
});

app.listen(8000, () => {
    console.log("Server running on port 8000");
  
});
app.get("/api/test", (req, res) => {
    res.json({ message: "Backend connected successfully 🚀" });
    console.log("HIT /api/test route");
  });