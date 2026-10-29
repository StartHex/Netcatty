export function pickOtpMenuChoice(promptText: string): number | null;
export type OtpMenuPlan =
  | { action: "skip" }
  | { action: "submit"; responses: string[]; choice: number };
export function planOtpMenuAutoSubmit(input: {
  prompts?: readonly { prompt?: string }[];
  autoSubmit?: boolean;
}): OtpMenuPlan;
