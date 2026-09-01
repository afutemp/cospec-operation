import { ref } from "vue";

const token = ref("");
export const auth = {
  token,
  set(value: string): void { token.value = value.trim(); },
  clear(): void { token.value = ""; },
  authenticated(): boolean { return token.value.length > 0; },
};
