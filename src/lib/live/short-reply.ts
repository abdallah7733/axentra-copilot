import type { Phrase } from "./engine";

/**
 * A caller phrase too short for the usual minimum (Phrase.short) is still sent when a read-back can use it: it starts
 * within SHORT_REPLY_MS after the agent stops, and is kept only if heard as one short reply word. Anything else stays a
 * "too short" drop, as before. Development console only: on when a read-back build setting is on (6:03 PM call, 23 Oct:
 * the caller's "Yes." to a read-back was dropped before any model heard it; again on the 2:15 AM call, 24 Oct).
 */
export const KEEP_SHORT_REPLIES = process.env.NEXT_PUBLIC_NAME_READ_BACK === "1" || process.env.NEXT_PUBLIC_ADDRESS_READ_BACK === "1";
export const SHORT_REPLY_MS = 5000;
const SHORT_REPLY = /^(yes|yeah|yep|yup|no|nope|correct|right|that's right|sure|okay|ok|mm-hmm|uh-huh)[.!?]?$/i;

/** Send this short caller phrase for transcription: it may be a reply to what the agent just said. */
export const sendShortReply = (phrase: Phrase, side: "agent" | "caller", agentEnd: number | null, enabled = KEEP_SHORT_REPLIES) =>
  enabled && !!phrase.short && side === "caller" && agentEnd !== null && phrase.startedAt >= agentEnd - 500 && phrase.startedAt - agentEnd <= SHORT_REPLY_MS;

/** What a short phrase was heard as is one short reply ("Yes.", "No.", "Correct."), not noise turned into words. */
export const isShortReply = (text: string) => SHORT_REPLY.test(text.trim());
