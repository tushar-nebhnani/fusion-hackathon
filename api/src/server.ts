import { createApp } from "./app.js";
import { connectDb, disconnectDb, prisma } from "./config/db.js";
import { env } from "./config/env.js";
import { createOpenMeteoClient } from "./services/climate/open-meteo.js";
import { createClimateService } from "./services/climate/profile.service.js";

await connectDb();

const openMeteo = createOpenMeteoClient();
const app = createApp({
  climate: createClimateService({ prisma, openMeteo }),
  checkDb: connectDb,
  upstreamStatus: () => openMeteo.status(),
});

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void disconnectDb().then(() => process.exit(0));
    });
  });
}
