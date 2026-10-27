# 《二五》扑克 · 网页版

单副 54 张牌、6 张底牌、总分 100 分的自定义升级玩法。Node.js 服务端权威判定，浏览器实时对战，适合部署在 NAS 上与好友开房。

## 功能

- 账号注册 / 登录，管理员后台（建号、改密、禁用、删除、设管理员、对局记录、统计）
- 大厅创建 / 加入房间，房间号 4 位，WebSocket 实时同步
- 三种玩法：抢庄（3/4 人）、队家（4 人 2V2）、噶点（4 人叫分）
- 人机补位：房主可随时添加 / 移除机器人，人机自动亮主、扣底、出牌，人数不足也能开局
- 亮主 / 反主、扣底、甩牌校验、金鸡强制跟牌、抠底翻倍、断线托管全部由服务端判定
- 数据保存在 `data/db.json`，密码 scrypt 哈希，登录 Cookie HMAC 签名

## 快速启动

### 方式一：Docker Compose（推荐 NAS 使用）

**最简单：只需一个 docker-compose.yml 文件**

下载仓库里的 `docker-compose.yml` 到任意目录，然后直接启动（会自动从 GitHub 拉取源码构建，无需手动 clone）：

```bash
# 下载 compose 文件
curl -O https://raw.githubusercontent.com/QQxiaobian/erwu/main/erwu/docker-compose.yml
# 可选：自定义初始管理员密码
ADMIN_PASSWORD='换成你的密码' docker compose up -d
```

也可以克隆仓库后构建：

```bash
git clone https://github.com/QQxiaobian/erwu.git
cd erwu/erwu
ADMIN_PASSWORD='换成你的密码' docker compose up -d --build
```

服务监听 `3000` 端口，浏览器访问 `http://NAS_IP:3000`。

数据目录挂载在 `./data`，升级只需重新 `docker compose up -d --build` 即可拉取最新代码，账号与对局记录保留。

> 若群晖等图形界面使用容器管理器，可导入仓库后用「docker-compose.yml」直接创建容器。

### 方式二：直接运行 Node

```bash
git clone https://github.com/QQxiaobian/erwu.git
cd erwu/erwu
npm install
npm start
```

要求 Node.js >= 18。

## 安卓 APP（可选）

仓库自带了一个 Android 原生壳（基于 Capacitor），把前端页面跑在 WebView 里，体验比浏览器更顺手。

### 安装 APK

1. 下载最新的 `app-debug.apk`（从 GitHub Actions Artifacts 或自行构建）
2. 用微信 / QQ 传到手机，或浏览器下载后安装
3. 首次启动会弹输入框，填你服务器地址，例如：
   - **局域网 NAS**：`http://192.168.1.100:3000`
   - **公网域名**：`https://erwu.yourdomain.com`
4. 地址保存在本地 SharedPreferences，后续自动连接；菜单里可随时修改

> Android 9+ 默认禁止明文 HTTP。本 APP 已配置 `usesCleartextTraffic=true` + `network_security_config.xml`，局域网 HTTP 可以直接用。如果服务器启用了 HTTPS 更安全，建议搭配 Let's Encrypt 或自签证书使用。

### 主要特性

- 包名 `com.erwu.game`，应用名「二五扑克」
- 返回键优先在 WebView 内部后退历史，没有历史才退出 App
- Edge-to-Edge 全屏，状态栏透明，支持刘海屏挖孔屏
- 仅需 `INTERNET` / `ACCESS_NETWORK_STATE` 权限
- minSdk 24（Android 7.0），targetSdk 36（Android 16）

### 自行构建 APK

前置依赖：JDK 21+、Android SDK（platforms;android-36 + build-tools;36.0.0）。

```bash
git clone https://github.com/QQxiaobian/erwu.git
cd erwu/erwu

# 安装 Capacitor 依赖（首次）
npm install

# Android SDK / JDK 环境变量
export ANDROID_HOME=$HOME/Android/Sdk
export JAVA_HOME=$HOME/.sdkman/candidates/java/21-tem

# 同步前端资源到 Android 工程
npx cap sync android

# 构建 debug APK（用本地 gradle 或 gradlew）
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

### 构建 Release 签名包（可选）

```bash
# 1. 生成 keystore（密码请妥善保管，不要提交到仓库）
keytool -genkey -v -keystore erwu-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias erwu

# 2. android/app/build.gradle 添加 signingConfigs，在 buildTypes.release 里引用

# 3. 构建
./gradlew assembleRelease
```

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
- **金鸡**：首发后其余玩家每人必须跟 2 张，有 2 张以上主牌须打出最大的两张主牌，金鸡直接赢墩
- **甩牌**：仅副牌可甩，校验失败自动降级为最小一张
- **杀牌**：张数必须与首出一致；多张牌组只比较组内最大一张
- **抠底**：最后一墩由抓分方赢下，底牌分数翻倍
- **抢庄 / 队家**：常家 ≥ 45 分获胜 / 上庄；亮 2 定主，25 可反主
- **队家庄家轮换**：每局发牌前先定庄家（拿底牌扣底的那位）。庄家队守庄成功则庄家轮到同队队友；常家上庄则庄家队换成常家队，并从原庄家的下家开始按座位顺序取第一个庄家队成员坐庄。亮主/反主只决定主花色，不改变庄家
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
