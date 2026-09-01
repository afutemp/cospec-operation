import { afterEach, describe, expect, it, vi } from "vitest";
import { auth } from "./auth";
import { ApiError, telemetryQueries } from "./api";

afterEach(() => { vi.unstubAllGlobals(); auth.clear(); });

describe("telemetryQueries", () => {
  it("sends the in-memory bearer token and maps JSON", async () => {
    auth.set("test-token");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0, limit: 20, offset: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(telemetryQueries.listRuns(20, 0)).resolves.toMatchObject({ total: 0 });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/runs?limit=20&offset=0", { headers: { authorization: "Bearer test-token" } });
  });

  it("clears the token after an unauthorized response", async () => {
    auth.set("expired");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
    await expect(telemetryQueries.getRunUsage({})).rejects.toEqual(new ApiError(401, "unauthorized"));
    expect(auth.authenticated()).toBe(false);
  });
});
