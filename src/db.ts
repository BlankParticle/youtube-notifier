import Database from "bun:sqlite";
import { env } from "./env";

// Initialize the database
export const db = new Database(env.DB_PATH, {
  create: true,
});
db.run(
  `CREATE TABLE IF NOT EXISTS channels (channelId TEXT PRIMARY KEY, leaseSeconds INTEGER)`
);

const commands = {
  getChannels: db.prepare<{ channelId: string }, []>(
    `SELECT channelId FROM channels`
  ),
  addChannel: db.prepare<null, [string, number | null]>(
    `INSERT INTO channels VALUES (?, ?)`
  ),
  removeChannel: db.prepare<null, string>(
    `DELETE FROM channels WHERE channelId = ?`
  ),
  updateChannel: db.prepare<null, [number | null, string]>(
    `UPDATE channels SET leaseSeconds = ? WHERE channelId = ?`
  ),
  getExpiringChannels: db.prepare<{ channelId: string }, number>(
    `SELECT channelId FROM channels WHERE leaseSeconds IS NOT NULL AND leaseSeconds < ?`
  ),
};

export const getChannels = () =>
  commands.getChannels.all().map(({ channelId }) => channelId);

export const addChannel = (channelId: string, leaseSeconds: number | null) => {
  try {
    commands.addChannel.run(channelId, leaseSeconds);
  } catch {
    // If the channel already exists, update the lease
    commands.updateChannel.run(leaseSeconds, channelId);
  }
};

export const removeChannel = (channelId: string) =>
  commands.removeChannel.run(channelId);

// Get channels that are expiring in the next hour
export const getExpiringChannels = () =>
  commands.getExpiringChannels.all(Date.now() / 1000 + 3600);
