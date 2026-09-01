import { expect, test } from "@playwright/test";
test("operator can authenticate, inspect overview and open a Run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cospec 运营看板" })).toBeVisible();
  await page.getByPlaceholder("Bearer Token").fill("e2e-token");
  await page.getByRole("button", { name: "进入看板" }).click();
  await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
  await expect(page.getByText("输入 Token", { exact: true }).locator("..").getByText("120", { exact: true })).toBeVisible();
  await page.getByText("Run 列表", { exact: true }).click();
  await expect(page.getByText("11111111…111111")).toBeVisible();
  await page.getByText("11111111…111111").click();
  await expect(page.getByRole("heading", { name: "Run 详情" })).toBeVisible();
  await page.getByRole("tab", { name: "资源与上下文" }).click();
  await expect(page.getByText("258,400 Token")).toBeVisible();
  await expect(page.getByText("压缩总次数")).toBeVisible();
});
