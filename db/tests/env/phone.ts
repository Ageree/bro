import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const phoneTestEnv = createEnv({
  server: {
    PHONE_TEST_DATABASE_URL: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
          ["localhost", "127.0.0.1"].includes(url.hostname) &&
          url.pathname === "/phone_integration"
        );
      }, "Use an isolated localhost Postgres database named phone_integration.")
      .optional(),
  },
  experimental__runtimeEnv: {},
});
