# DCMS Project Status

## 项目概览
- 项目名：刀塔社区赛综合管理系统（DCMS）
- 仓库：`ssh://git@ssh.github.com:443/rookieandroid/DCMS.git`
- 主要目标：提供一个可演示的社区赛事 MVP，覆盖玩家库、数字 ID 登录、赛事报名、内战选人、选手拍卖。

## 当前已完成功能
- 首页
  - 管理员登录
  - 玩家数字 ID 登录
  - 当前赛事列表展示
  - 玩家报名 / 取消报名
  - 首页公开玩家库筛选
- 玩家库管理
  - 新增、编辑、删除玩家
  - 数字 ID 唯一且创建后不可修改
  - 按关键词、位置、战力排序筛选
- 赛事与报名管理
  - 创建赛事
  - 删除赛事
  - 开启 / 关闭报名
  - 管理员代报名
  - 任命队长并初始化赛事
- 内战选人
  - 按队长轮次选人
  - 按当前规则限制非当前队长操作
  - 实时同步队伍战力和选人记录
- 拍卖大厅
  - 创建拍卖
  - 每位队长独立预算分配
  - 启动拍卖
  - 暂停 / 继续拍卖
  - 倒计时成交 / 流拍
  - SSE 实时更新
- 安全基础能力
  - 管理员口令使用环境变量
  - 关键接口基础限流
  - 操作审计日志

## 当前页面结构
- `首页`
- `选手拍卖页`
- `内战选人页`

## 技术结构
- 后端入口：[`server.js`](/Users/pomcat/Documents/DCMS/server.js)
- 前端入口：[`public/app.js`](/Users/pomcat/Documents/DCMS/public/app.js)
- 样式：[`public/styles.css`](/Users/pomcat/Documents/DCMS/public/styles.css)
- 服务层：
  - [`src/services/auth.js`](/Users/pomcat/Documents/DCMS/src/services/auth.js)
  - [`src/services/players.js`](/Users/pomcat/Documents/DCMS/src/services/players.js)
  - [`src/services/events.js`](/Users/pomcat/Documents/DCMS/src/services/events.js)
  - [`src/services/inhouse.js`](/Users/pomcat/Documents/DCMS/src/services/inhouse.js)
  - [`src/services/auctions.js`](/Users/pomcat/Documents/DCMS/src/services/auctions.js)
- 数据文件：
  - [`data/dcms-db.json`](/Users/pomcat/Documents/DCMS/data/dcms-db.json)

## 本地开发
- 启动：
```bash
PORT=3010 HOST=127.0.0.1 node server.js
```
- 测试：
```bash
node --test
```

## 线上部署信息
- 当前可用入口：
  - [http://150.158.55.21](http://150.158.55.21)
- 域名状态：
  - `dcmsdota.com` 与 `www.dcmsdota.com` 曾经已配置 HTTPS
  - 因工信部备案原因，域名当前已暂时关闭，不作为现阶段访问入口
- 临时访问说明：
  - 当前 `nginx` 已增加 IP 访问配置
  - 玩家现阶段通过公网 IP 临时访问系统
- 服务器系统：Ubuntu 22.04
- 服务器公网 IP：`150.158.55.21`
- 部署目录：`/var/www/DCMS`
- 进程管理：`pm2`
- PM2 应用名：`dcms`
- Nginx 当前同时支持：
  - 域名 HTTPS 配置保留
  - 公网 IP 的 HTTP 临时访问

## 线上运行方式
- PM2 配置文件：`/var/www/DCMS/ecosystem.config.cjs`
- 关键环境变量：
  - `NODE_ENV=production`
  - `HOST=127.0.0.1`
  - `PORT=3010`
  - `DCMS_ADMIN_PASSWORD=...`

注意：
- 不要把真实管理员口令提交到 Git 仓库
- 不要把服务器密码、管理员口令写进这个文件

## 发布方式
理想方式：
1. 本地提交并推送到 GitHub
2. 服务器拉取最新代码
3. 重启 PM2 服务

当前实际情况：
- 本地 GitHub 推送正常
- 服务器尚未配置 GitHub 拉取凭据
- 最近一次发布使用了“同步变更文件到服务器 + PM2 重启”的方式
- 由于域名暂时关闭，最近一次运维还额外调整了 `nginx`，允许 `http://150.158.55.21` 直接访问应用

## 常用运维命令
- 查看 PM2 状态：
```bash
pm2 list
```
- 查看日志：
```bash
pm2 logs dcms
```
- 用配置文件重启：
```bash
pm2 restart /var/www/DCMS/ecosystem.config.cjs --update-env
pm2 save
```

## 审计与安全
- 审计日志位置：`/var/www/DCMS/data/audit.log`
- 生产环境管理员口令来源：`DCMS_ADMIN_PASSWORD`
- 已做基础限流与操作审计

## 最近完成的前端优化
- 首页增加赛事概览指标卡
- 首页增加赛事 Spotlight 区
- 首页增加公开玩家库筛选
- 管理后台增加玩家库搜索、位置筛选、战力排序
- 赛事管理增加赛事概览快捷切换
- 拍卖配置区增加赛事准备度信息

## 建议下一步
- 给服务器配置 GitHub SSH 凭据，恢复标准 `git pull` 发布流程
- 域名备案完成后，恢复 `dcmsdota.com` 作为正式入口，并视情况重新开启强制 HTTPS
- 增加赛事编辑能力
- 增加玩家批量导入
- 拍卖页和内战页继续做大屏化视觉增强
- 逐步把 JSON 存储迁移到数据库

## 给下一次 Codex 的推荐提示词
```text
这是 DCMS 项目，请先阅读 PROJECT_STATUS.md 和仓库代码。当前正式域名 dcmsdota.com 因备案原因暂时关闭，现阶段线上入口是 http://150.158.55.21 。服务器是 Ubuntu 22.04，部署目录 /var/www/DCMS，pm2 进程名 dcms，nginx 保留了域名 HTTPS 配置，同时增加了 IP 的 HTTP 临时访问。请基于当前仓库继续开发，不要改动生产口令，只修改代码和必要的部署脚本。
```
