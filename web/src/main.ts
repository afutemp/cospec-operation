import { createApp } from "vue";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router";
import "./styles.css";

createApp(App).use(VueQueryPlugin).use(router).mount("#app");
