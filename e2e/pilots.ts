/**
 * The owner's email a pilot list of the app under test names (e2e.config.ts)
 * for the one test that needs the pilot: the suite otherwise runs as
 * production does, with no pilot on. The test gives this email to a person
 * of its own in the run's database (e2e/chat/cross-channel.e2e.ts), so only
 * that person's workspace is in the pilot. `.invalid` is reserved: it is
 * never a real address.
 */
export const crossChannelPilotEmail = "cross-channel-pilot@e2e.invalid";
