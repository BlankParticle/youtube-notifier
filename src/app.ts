import { Hono } from "hono";
import { env } from "./env";
import { YoutubePubsub } from "./youtube-pubsub";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { file } from "bun";
import { getChannels } from "./db";

// Initialize the YoutubePubsub instance
const yt = new YoutubePubsub(`${env.HOST_URL}/youtube`, env.PUBSUB_SECRET);
yt.on("subscribe", (data) => console.info("Subscribed to", data.channelId));
yt.on("unsubscribe", (data) =>
  console.info("Unsubscribed from", data.channelId)
);
yt.on("notify", async (data) => {
  console.info("Received notification\n", data);
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `New video from [${data.channel.name}](${data.channel.link})\n**${data.video.title}**\n${data.video.link}`,
    }),
  });
});
yt.on("error", (err) => console.error(err));

const definedSubscriptions = file(env.SUBSCRIPTIONS_PATH);
if (await definedSubscriptions.exists()) {
  const channels = z
    .array(z.string())
    .safeParse(await definedSubscriptions.json());
  if (channels.success) {
    yt.subscribe(channels.data);
  } else {
    console.error("Invalid subscriptions file, ignoring...");
  }
}

// Initialize the Hono app
const app = new Hono();

app.use(logger());

app.get("/", (c) => c.body("Ready!"));
app.all("/youtube", async (c) => yt.handler(c.req.raw));

app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth !== env.PUBSUB_SECRET) {
    return c.body("Unauthorized", 401);
  } else {
    return await next();
  }
});

app.post(
  "/api/subscribe",
  zValidator(
    "json",
    z.object({
      channels: z.array(z.string()),
    })
  ),
  async (c) => {
    const channels = c.req.valid("json").channels;
    await yt.subscribe(channels);
    return c.json({ message: "Subscribed to channels" });
  }
);

app.post(
  "/api/unsubscribe",
  zValidator(
    "json",
    z.object({
      channels: z.array(z.string()),
    })
  ),
  async (c) => {
    const channels = c.req.valid("json").channels;
    await yt.unsubscribe(channels);
    return c.json({ message: "Unsubscribed from channels" });
  }
);

app.get("/api/subscriptions", (c) => c.json({ channels: getChannels() }));

app.notFound((c) => c.body("Not Found", 404));
app.onError((err, c) => {
  console.error(err);
  return c.body("Internal Server Error", 500);
});

const server = Bun.serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`Server running on port ${env.PORT}`);

// Exit handling
let isClosing = false;
const handleExit = async () => {
  if (isClosing) return;
  isClosing = true;
  await yt.close();
  console.log("Closing server...");
  server.stop();
  process.exit();
};

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);
