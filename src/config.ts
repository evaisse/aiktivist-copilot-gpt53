export type AppConfig = {
  port: number;
  dbPath: string;
  logsPath: string;
  openrouterBaseUrl: string;
  openrouterApiKey: string;
  defaultModel: string;
  adminUsername: string;
  adminPassword: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? "3000"),
    dbPath: env.DB_PATH ?? "./data/aiktivist.db",
    logsPath: env.EVENTS_LOG_PATH ?? "./logs/events.jsonl",
    openrouterBaseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openrouterApiKey: env.OPENROUTER_API_KEY ?? "",
    defaultModel: "google/gemini-3-flash-preview",
    adminUsername: env.ADMIN_USERNAME ?? "admin",
    adminPassword: env.ADMIN_PASSWORD ?? "change-me-now"
  };
}
