# Idle Lineage Class

## 更新紀錄

| 更新時間   | 版號      | 更新內容                                                                                   |
| ---------- | --------- | ------------------------------------------------------------------------------------------ |
| 2026-09-13 | `v3.8.43` | 完整優化寵物保管：本角色直接出戰寵物置頂並以亮色標示；本角色傭兵攜帶的寵物接續排列並可直接收回；其他角色未遊玩時可直接收回，正在遊玩及其他角色傭兵租借仍受保護。 |
| 2026-09-13 | `v3.8.42` | 新增 Google 登入與 Google Drive 隱藏應用資料的全部進度手動同步，提供本機／雲端差異比較與雙向覆蓋。 |
| 2026-09-13 | `v3.8.41` | 調整進化果實配方：光明的鱗片需求量由 100 片降為 5 片。                              |
| 2026-09-13 | `v3.8.40` | 調整寵物系統：保管上限由 32 隻提升至 64 隻，同時出戰上限由 4 隻提升至 8 隻。                    |
| 2026-09-13 | `v3.8.39` | 協力傭兵改由來源角色直接累積經驗與善惡值，沿用既有存檔時機批次寫回；移除待領帳本，並新增同角色跨分頁遊玩／出借互斥與來源角色世代驗證。 |
| 2026-09-13 | `v3.8.38` | 新增 `AGENT.md`，規範每次更新需新增版號並同步維護 README；更新紀錄改以更新時間與版號記錄。 |
| 2026-09-13 | `v3.8.37` | 修正匯入所有進度後的角色存檔防寫入鎖問題。                                                 |
| 2026-09-12 | `v3.8.37` | 新增匯出全部與匯入全部功能。                                                               |
| 2026-09-12 | `v3.8.37` | 優化黑市：改為顯示 300 格，並支援一次更新全部。                                            |
| 2026-09-12 | `v3.8.37` | 修正傭兵寵物等級被覆蓋的問題。                                                             |
| 2026-09-12 | `v3.8.37` | 將預設喝水門檻調整為 70%。                                                                 |
| 2026-09-12 | `v3.8.37` | 新增傭兵寵物出戰功能。                                                                     |

## 專案來源與維護

本專案 fork 自 [shines871/idle-lineage-class](https://github.com/shines871/idle-lineage-class)。

- 原作者：`shines871`
- 原作者版本：https://shines871.github.io/idle-lineage-class/
- 本 fork 維護者：`RURO006`
- 本 fork 專案：https://github.com/RURO006/idle-lineage-class

本版本由 RURO006 進行功能修正、平衡調整與錯誤修復，並不代表原作者的官方版本或立場。請以本專案的更新紀錄判斷本 fork 的變更內容。

依原始專案目前保留的聲明，本專案僅供非商業用途；轉載或再發布時，請保留 `shines871` 原作者出處、原始專案連結與相關版權聲明。遊戲內圖片與音樂的版權仍歸原權利方所有。

部署在非原作者網域時，頁面頂端每 7 天最多顯示一次來源提示。提示可按「關閉」立即收起，7 天後才會再次顯示。

## Google Drive 雲端存檔設定

網頁版預設仍使用瀏覽器本機存檔。若要啟用 Google 登入與 Google Drive 雲端存檔：

1. 在 Google Cloud Console 建立專案並啟用 Google Drive API。
2. 建立 OAuth Client ID，類型選擇「Web application」。
3. 將正式網站的 JavaScript origin 設為 `https://ruro006.github.io`；本機測試時另外加入使用的 localhost origin。
4. 將 Web Client ID 填入 [`js/google-drive-config.js`](js/google-drive-config.js) 的 `window.IDLE_LINEAGE_GOOGLE_CLIENT_ID`。
5. 在 OAuth Consent Screen 設定應用名稱、支援信箱與隱私權政策網址，可參考 [`privacy.html`](privacy.html)。

雲端存檔使用 Google Drive 的 `appDataFolder`，檔案不會顯示在使用者的 Drive 介面；雲端操作只在標題畫面手動執行。本機「匯出所有進度／匯入所有進度」仍可作為可見備份方式。

本方案沒有自建後端、資料庫或 Firebase 月租；Google Drive API 標準使用通常沒有額外 API 費用，但存檔會計入使用者自己的 Google 儲存空間配額。詳見 [Drive API 使用限制](https://developers.google.com/workspace/drive/api/guides/limits) 與 [Google 儲存空間說明](https://support.google.com/drive/answer/9312312?hl=zh-Hant)。
