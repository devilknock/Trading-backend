// sendSignal.js
const axios = require("axios");

async function sendTestSignal() {
  try {
    const response = await axios.post("http://localhost:5000/api/signal", {
      symbol: "BTCUSDT",
      signal: "BUY",
      meta: { note: "test from sendSignal.js" }
    });
    console.log("✅ Signal sent successfully:", response.data);
  } catch (error) {
    console.error("❌ Error sending signal:", error.message);
  }
}

sendTestSignal();
