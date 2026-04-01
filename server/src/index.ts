import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`[API] T Rock CRM server running on port ${PORT}`);
});
