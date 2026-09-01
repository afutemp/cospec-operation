import { ref } from "vue";

const STORAGE_KEY = "cospec_telemetry_token";
function storedToken(): string { try { return sessionStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; } }
const token = ref(storedToken());
export const auth = {
  token,
  set(value: string): void { token.value = value.trim(); try { sessionStorage.setItem(STORAGE_KEY, token.value); } catch { /* memory fallback */ } },
  clear(): void { token.value = ""; try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* memory fallback */ } },
  authenticated(): boolean { return token.value.length > 0; },
};
