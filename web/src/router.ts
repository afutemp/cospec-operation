import { createRouter, createWebHistory } from "vue-router";
import { auth } from "./auth";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      component: () => import("./views/LoginView.vue"),
      meta: { public: true },
    },
    { path: "/", component: () => import("./views/OverviewView.vue") },
    { path: "/workflows", component: () => import("./views/RunsView.vue") },
    { path: "/skills", component: () => import("./views/SkillsView.vue") },
    { path: "/adoption", component: () => import("./views/AdoptionView.vue") },
    { path: "/users", component: () => import("./views/UsersView.vue") },
    {
      path: "/workflows/:runId",
      component: () => import("./views/RunDetailView.vue"),
    },
  ],
});
router.beforeEach((to) => {
  if (!to.meta.public && !auth.authenticated())
    return { path: "/login", query: { redirect: to.fullPath } };
  if (to.path === "/login" && auth.authenticated()) return "/";
  return true;
});
