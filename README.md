# My Music Carousel Channel

本專案是一個本機播放用的音樂輪播台。程式會讀取 data/config.yaml，然後無限循環播放作品：有 PV 且設定啟用 PV 時播放 PV；沒有 PV 時播放音訊，並從 data/bg-image 隨機輪播背景圖，約 40 秒更換一張。

純音樂作品會在歌詞區顯示「純音樂，請欣賞」。非純音樂作品會讀取對應 LRC 檔案並同步顯示滾動歌詞。

## 啟動

npm install
npm start

## data 目錄

data/config.yaml 是資產庫入口。背景圖放在 data/bg-image，音訊放在 data/music/data，歌詞放在 data/music/lyrics，PV 放在 data/video。

## 管理介面

共有四頁：資產管理、資產匯出、播放設定、正式播放。資產管理支援拖放入庫；資產匯出會把 data 打包成 zip；播放設定包含字體、PV 開關、播放模式、背景圖模式，並提供 Save、Apply、Cancel、Launch；正式播放頁可直接開新視窗展示播放畫面。
