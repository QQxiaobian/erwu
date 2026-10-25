# 《二五》扑克 · 网页版

单副 54 张牌、6 张底牌、总分 100 分的自定义升级玩法。Node.js 服务端权威判定，浏览器实时对战，适合部署在 NAS 上与好友开房。

## 功能

- 账号注册 / 登录，管理员后台（建号、改密、禁用、删除、设管理员、对局记录、统计）
- 大厅创建 / 加入房间，房间号 4 位，WebSocket 实时同步
- 三种玩法：抢庄（3/4 人）、队家（4 人 2V2）、噶点（4 人叫分）
- 亮主 / 反主、扣底、甩牌校验、金鸡强制跟牌、抠底翻倍、断线托管全部由服务端判定
- 数据保存在 `data/db.json`，密码 scrypt 哈希，登录 Cookie HMAC 签名

## 快速启动

### 方式一：Docker Compose（推荐 NAS 使用）

```bash
cd erwu
# 可选：自定义初始管理员密码
ADMIN_PASSWORD='换成你的密码' docker compose up -d --build
```

服务监听 `3000` 端口，浏览器访问 `http://NAS_IP:3000`。

数据目录挂载在 `./data`，升级只需替换代码后重新 `docker compose up -d --build`，账号与对局记录保留。

### 方式二：直接运行 Node

```bash
cd erwu
npm install
npm start
```

要求 Node.js >= 18。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / WebSocket 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录（Docker 内为 `/data`） |
| `ADMIN_USER` | `admin` | 首次启动创建的管理员账号 |
| `ADMIN_PASSWORD` | `admin123` | 首次启动创建的管理员密码 |
| `ALLOW_REGISTER` | `1` | 设为 `0` 关闭自助注册，仅管理员建号 |

> 首次登录后请立即在管理员后台修改默认密码。

## NAS 反向代理提示

若通过 Nginx / 群晖反向代理对外访问，需要转发 WebSocket：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

## 玩法要点

- **牌力**：任意花色 5 > 大王 > 小王 > 任意花色 2 > 本局主花色普通牌（A>K>Q>J>10>9>8>7>6>4>3）> 副牌
- **牌型**：单张、同花色 25 组合、金鸡（大王+小王）、副牌甩牌；一次只能出一种
- **金鸡**：首发后其余玩家有主牌必须出手里最大主牌，金鸡直接赢墩
- **甩牌**：仅副牌可甩，校验失败自动降级为最小一张
- **杀牌**：张数必须与首出一致；多张牌组只比较组内最大一张
- **抠底**：最后一墩由抓分方赢下，底牌分数翻倍
- **抢庄 / 队家**：常家 ≥ 45 分获胜 / 上庄；亮 2 定主，25 可反主
- **噶点**：无亮反主，55 分起叫、5 的倍数递增，专家拿底后自选主花色，得分 ≥ 叫分则胜

## 开发与测试

```bash
npm test          # 规则单元测试 + 完整对局
node test/stress.js  # 随机对局压力测试（四种模式各 120 局）
```

## 目录结构

```
server.js            HTTP / REST / WebSocket 入口
src/hub.js           WebSocket 中枢、房间列表与消息路由
src/room.js          对局状态机（发牌 → 亮主/叫分 → 扣底 → 出牌 → 结算）
src/game/cards.js    规则引擎（牌力、牌型、跟牌、甩牌、墩归属、托管选牌）
src/db.js            JSON 持久化与账号管理
src/auth.js          Cookie 签名鉴权
public/              前端单页（index.html / style.css / app.js）
test/                规则测试与压力测试
```
