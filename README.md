# 双系家谱

这是按 PRD 的 Milestone 1 和 Milestone 2 实现的静态网页版 MVP。

## 当前能力

- 首次进入创建“我”的档案。
- 人物与关系分离存储，数据保存在浏览器 `localStorage`。
- 任意成员可添加父亲、母亲、儿子、女儿、配偶。
- 父亲和母亲关系做唯一校验，配偶关系双向创建。
- 成员列表、成员详情、编辑成员、软删除成员。
- 出生时间支持“精确年份”和“模糊时间”，错误会显示在输入框下方。
- 局部主轴树：父母线只连接当前中心人物，配偶作为侧挂节点显示。
- 局部树按家庭单元展示子女，子女过多时默认折叠。
- 全局图入口 `/tree/global`，支持搜索、缩放、拖动画布、回到我。
- 待补充入口 `/incomplete`，列出缺出生时间、缺父母、占位成员等。
- 点击任意树节点可切换为该节点为中心，一键回到“我”。

## 运行方式

直接用浏览器打开 `index.html` 即可运行，无需安装依赖。

## 后续迁移建议

如果继续做 Next.js + Prisma + SQLite 版本，可以把 `app.js` 中的 `persons` / `relations` 数据结构直接迁到 Prisma schema，再把当前的创建、查询和校验逻辑拆到 API route 或 server actions。

当前静态版没有引入 React Flow；全局图用原生 HTML/CSS/JS 实现可拖拽和缩放，便于无依赖运行。后续迁移到 React/Next.js 后，可把全局图替换为 React Flow 的 `PersonNode + FamilyUnitNode`。
