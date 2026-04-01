import pg from "pg";

const PG_NOTIFY_CHANNEL = "crm_events";

let activeClient: pg.Client | null = null;
let reconnecting = false;

export async function startListener(onEvent: (event: any) => void): Promise<pg.Client> {
  // Close existing client if reconnecting — prevents duplicate listeners
  if (activeClient) {
    activeClient.removeAllListeners();
    await activeClient.end().catch(() => {});
    activeClient = null;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  activeClient = client;

  await client.connect();
  await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);

  client.on("notification", (msg) => {
    if (msg.channel === PG_NOTIFY_CHANNEL && msg.payload) {
      try {
        const event = JSON.parse(msg.payload);
        // Parse timestamp string back to Date after JSON deserialization
        if (event.timestamp && typeof event.timestamp === "string") {
          event.timestamp = new Date(event.timestamp);
        }
        onEvent(event);
      } catch (err) {
        console.error("[Worker] Failed to parse event:", err);
      }
    }
  });

  client.on("error", async (err) => {
    console.error("[Worker] PG listener error:", err);
    // Reconnect with guard to prevent stacking
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(async () => {
        try {
          await startListener(onEvent);
        } catch (reconnectErr) {
          console.error("[Worker] Reconnect failed:", reconnectErr);
        } finally {
          reconnecting = false;
        }
      }, 5000);
    }
  });

  console.log(`[Worker] Listening on PG channel: ${PG_NOTIFY_CHANNEL}`);
  return client;
}
