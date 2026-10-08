import { z } from "zod";

export const domesticPhoneSchema = z
  .string()
  .regex(
    /^\+7[3489]\d{9}$/u,
    "Use a full domestic Russian +7 number; premium, emergency and Kazakhstan numbers are not allowed."
  )
  .refine(
    (number) => !number.startsWith("+7809") && !number.startsWith("+7803"),
    "Premium numbers are not allowed."
  );
