import { expect, test } from "@playwright/test";
test("operator can authenticate, inspect overview and open a Run", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Cospec 运营看板" }),
  ).toBeVisible();
  await page.getByPlaceholder("Bearer Token").fill("e2e-admin-token");
  await page.getByRole("button", { name: "进入看板" }).click();
  await expect(page.getByRole("heading", { name: "运营概览" })).toBeVisible();
  await expect(
    page
      .getByText("活跃用户（估算）", { exact: true })
      .locator("xpath=ancestor::article")
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("活跃用户（估算）", { exact: true })
      .locator("xpath=ancestor::article")
      .getByText("较上期新增 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("article.hero.violet").getByText(/有产出/),
  ).toBeVisible();
  await expect(page.getByText("活跃用户趋势", { exact: true })).toBeVisible();
  await expect(page.getByText("工作流启动趋势", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新数据" })).toBeVisible();
  await expect(page.getByText("测试规划员", { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "运营概览" })).toBeVisible();
  await page.locator(".range-select").click();
  await page.getByRole("option", { name: "自定义", exact: true }).click();
  await expect(page.getByText("自定义时间范围", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".range-select").click();
  await page.getByRole("option", { name: "最近 24 小时", exact: true }).click();
  await expect(
    page.locator(".range-select").getByText("最近 24 小时", { exact: true }),
  ).toBeVisible();
  // 运营故事：从概览进入工作流分析，再筛选并下钻到具体工作流。
  await page.locator("article.hero.violet").click();
  await expect(page).toHaveURL(/\/workflows\?.*from=/);
  await expect(page.getByRole("heading", { name: "工作流分析" })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新数据" })).toBeVisible();
  await expect(
    page.locator(".range-select").getByText("最近 24 小时", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("工作流结果趋势", { exact: true })).toBeVisible();
  await expect(page.getByText("全部用户", { exact: true })).toBeVisible();
  await expect(page.getByText("全部产线", { exact: true })).toBeVisible();
  await expect(
    page.locator(".el-table").getByText("测试规划员", { exact: false }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/from=/);
  await expect(page.getByText("11111111…111111")).toBeVisible();
  await page.getByText("11111111…111111").click();
  await expect(page.getByRole("dialog", { name: "工作流详情" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "工作流详情" }).locator(".summary-title h2"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "执行概览" })).toBeVisible();
  await page.getByRole("button", { name: "交付产物", exact: true }).click();
  await expect(page.getByText("📁 outputs", { exact: true })).toBeVisible();
  await expect(
    page.getByText("📁 tr1-requirements-spec", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("tr1用户需求文档_评审版.md")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("tr1用户需求文档_评审版.md");
  await page.getByRole("button", { name: "资源消耗", exact: true }).click();
  await expect(page.getByText("258,400 Token")).toBeVisible();
  await expect(page.getByText("压缩总次数")).toBeVisible();
  await page.getByRole("button", { name: "数据诊断", exact: true }).click();
  await expect(page.getByText("原始 JSONL", { exact: true })).toBeVisible();
  const rawDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 JSONL" }).click();
  const rawDownload = await rawDownloadPromise;
  expect(rawDownload.suggestedFilename()).toMatch(/\.jsonl$/);
  await page.keyboard.press("Escape");

  // SKILL 分析：从汇总趋势进入单个 SKILL，再下钻相关工作流。
  await page.getByRole("menuitem", { name: "SKILL 分析" }).click();
  await expect(page.getByRole("heading", { name: "SKILL 分析" })).toBeVisible();
  await expect(page.getByText("SKILL 使用趋势", { exact: true })).toBeVisible();
  await expect(page.locator(".el-table").getByText("tr1-requirements-spec", { exact: true })).toBeVisible();
  await page.locator(".el-table__row").first().click();
  await expect(page.getByRole("dialog", { name: "tr1-requirements-spec" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "tr1-requirements-spec" }).getByText("执行趋势")).toBeVisible();
  await page.getByRole("dialog", { name: "tr1-requirements-spec" }).getByRole("button", { name: "查看相关工作流" }).click();
  await expect(page).toHaveURL(/\/workflows\?.*skill=tr1-requirements-spec/);

  // 推广使用：观察整体覆盖，并从产线下钻到人员。
  await page.getByRole("menuitem", { name: "推广使用" }).click();
  await expect(page.getByRole("heading", { name: "推广使用" })).toBeVisible();
  await expect(page.getByText("活跃用户趋势", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent 使用情况", { exact: true })).toBeVisible();
  await expect(page.getByText("Cospec 版本使用情况", { exact: true })).toBeVisible();
  await expect(page.locator(".el-table").getByText("研发体系/工程技术部", { exact: true })).toBeVisible();
  await page.locator(".el-table").getByText("研发体系/工程技术部", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "研发体系/工程技术部" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "研发体系/工程技术部" }).getByText("测试规划员", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // 用户管理：管理员创建独立的只读账号，Token 只显示一次。
  await page.getByRole("menuitem", { name: "用户管理" }).click();
  await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
  await page.getByRole("button", { name: "新建账号" }).click();
  await page.getByPlaceholder("例如：运营同事").fill("运营同事");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByText("运营同事 创建成功", { exact: true })).toBeVisible();
  await expect(page.locator(".token-box code")).toHaveText(/^ctu_/);
  await page.getByRole("button", { name: "我已保存" }).click();
  await expect(page.locator(".el-table").getByText("运营同事", { exact: true })).toBeVisible();
});
