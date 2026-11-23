import { describe, expect, it } from "vitest";
import { ollamaNumThread } from "../../config/ollama-threads.js";

describe("ollamaNumThread", () => {
  it("passes a positive integer through and ignores everything else", () => {
    expect(ollamaNumThread({ MNEMO_OLLAMA_NUM_THREAD: "4" })).toEqual({ numThread: 4 });
    for (const bad of [undefined, "", "0", "-2", "2.5", "many"])
      expect(ollamaNumThread({ MNEMO_OLLAMA_NUM_THREAD: bad })).toEqual({});
  });
});
