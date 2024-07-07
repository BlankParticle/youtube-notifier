import EventEmitter from "events";
import { parse } from "url";
import { z } from "zod";
import { addChannel, getChannels, removeChannel } from "./db";
import { XMLParser } from "fast-xml-parser";
import { createHmac } from "crypto";

const BASE_TOPIC_URL =
  "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

type EventMap = {
  subscribe: { channelId: string; leaseSeconds: number | null }[];
  unsubscribe: { channelId: string }[];
  notify: any[];
  error: { type: "subscribe" | "unsubscribe"; channel: string; error: Error }[];
  close: void[];
};

export class YoutubePubsub extends EventEmitter<EventMap> {
  private isClosing = false;

  constructor(private callbackUrl: string, private secret: string) {
    super();
  }

  public async subscribe(channels: string[]) {
    for (const channel of channels) {
      await this.request(channel, "subscribe").catch((error) => {
        this.emit("error", {
          type: "subscribe",
          channel,
          error,
        });
      });
    }
  }

  public async unsubscribe(channels: string[]) {
    for (const channel of channels) {
      await this.request(channel, "unsubscribe").catch((error) => {
        this.emit("error", {
          type: "unsubscribe",
          channel,
          error,
        });
      });
    }
  }

  public handler(req: Request) {
    if (req.method === "GET") {
      return this.handleVerification(req);
    } else if (req.method === "POST") {
      return this.handleNotification(req);
    } else {
      return new Response("Forbidden", { status: 403 });
    }
  }

  public async close() {
    if (getChannels().length === 0) return;
    this.isClosing = true;
    await this.unsubscribe(getChannels());
    console.log("\nWaiting for all subscriptions to close...");
    // Wait for all subscriptions to close with 30 seconds timeout
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 10_000)),
      new Promise<void>((resolve) => {
        if (getChannels().length === 0) resolve();
        this.once("close", resolve);
      }),
    ]);
  }

  private handleVerification(req: Request) {
    const { query } = parse(req.url, true, true);
    const data = z
      .object({
        "hub.topic": z.string().url(),
        "hub.mode": z.string(),
        "hub.challenge": z.string(),
        "hub.lease_seconds": z.coerce
          .number()
          .optional()
          .nullable()
          .default(null),
      })
      .transform((data) => ({
        topic: data["hub.topic"],
        mode: data["hub.mode"],
        challenge: data["hub.challenge"],
        leaseSeconds: data["hub.lease_seconds"],
      }))
      .safeParse(query);

    if (!data.success) {
      return new Response("Bad Request", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const { topic, mode, challenge, leaseSeconds } = data.data;
    const channelId = topic.replace(BASE_TOPIC_URL, "");

    if (mode === "subscribe") {
      this.emit(mode, { channelId, leaseSeconds });
      addChannel(channelId, leaseSeconds);
    } else if (mode === "unsubscribe") {
      this.emit(mode, { channelId });
      removeChannel(channelId);
      if (this.isClosing && getChannels().length === 0) {
        this.emit("close");
      }
    }

    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  private async handleNotification(req: Request) {
    const xml = await req.text();
    const parser = new XMLParser();
    const data = parser.parse(xml, {
      allowBooleanAttributes: true,
    });
    const signature = req.headers.get("x-hub-signature");
    if (!signature) {
      return new Response("Forbidden", { status: 403 });
    }
    if (data.feed["at:deleted-entry"])
      return new Response("OK", { status: 200 });

    const video = data.feed.entry;
    if (!video) {
      return new Response("Bad Request", { status: 400 });
    }

    const signatureParts = signature.split("=");
    const algo = (signatureParts.shift() || "").toLowerCase();
    const matchingParts = (signatureParts.pop() || "").toLowerCase();

    let hmac: ReturnType<typeof createHmac>;
    try {
      hmac = createHmac(algo, this.secret);
    } catch (_) {
      return new Response("Forbidden", { status: 403 });
    }
    hmac.update(xml);

    // Return a 200 response even if secret did not match
    if (hmac.digest("hex").toLowerCase() !== matchingParts) {
      return new Response("OK", { status: 200 });
    }

    const videoId = video["yt:videoid"];
    const publishTIme = new Date(video.published);
    const updateTime = new Date(video.updated);

    const videoData = {
      video: {
        id: videoId,
        title: video.title,
        link: video.link,
      },
      channel: {
        id: video["yt:channelid"],
        name: video.author.name,
        link: video.author.uri,
      },
      published: publishTIme,
      updated: updateTime,
    };

    this.emit("notify", videoData);
    return new Response("OK", { status: 200 });
  }

  private async request(channelId: string, type: "subscribe" | "unsubscribe") {
    const topic = `${BASE_TOPIC_URL}${channelId}`;
    const body = new URLSearchParams({
      "hub.callback": this.callbackUrl,
      "hub.mode": type,
      "hub.topic": topic,
      "hub.verify": "async",
      "hub.secret": this.secret,
    });
    const res = await fetch(HUB_URL, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (res.status !== 202) {
      throw new Error(`Failed to ${type} to ${channelId}`);
    }
  }
}
