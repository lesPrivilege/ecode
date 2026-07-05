# Note — Subagent 經濟學：一次實證記錄

時間：2026-07。場景：Mnemos M1/atlas 輪，subagent-driven development
（每任務新開實現 agent + spec 合規 review + 代碼質量 review 雙審）。

## 觀察

九筆提交的一輪 ≈ 二十餘次 agent 冷啟動，每次冷啟動重讀大量相同的 repo 上下文。
隔離審查在兩類場景回報懸殊：

- **回本**：判斷密集或高風險提交。實例：bigStore 寫確認機制的 race condition
  被獨立 review 抓出（實現者敘事會誘導同 context 的 reviewer 順着想——隔離
  提供的「新鮮眼睛」在此有真實對象：context 污染）。
- **虧損**：機械性串行任務（atlas 逐幀、字符串搬運）。無污染可防，冷啟動稅
  照繳；per-frame 全新 spec review 讀的是和上一幀幾乎相同的文件。

邊界條件一句話：**隔離的價值只在「有污染可防」時兌現**。這不是實現瑕疵,
是 subagent-per-task 模式的結構性成本，主流 agent 架構（死保前綴命中 vs
濫發 subagent 兩個極端）對某些任務類型皆然。

## 應對（本 repo 已採用的分層策略）

同一實現 agent 貫穿分支；orchestrator 直接讀 diff 審機械提交；獨立雙審只留給
動數據層/啟動路徑、判斷密集、分支收口 holistic 三類；派發時附精確文件清單 +
摘要（父代替子代做定向壓縮），禁探索式閱讀。

## 與 compaction economy 的關係（三檔位模型）

長時程 agent 的 context 管理三策略：全量壓縮（stop-the-world GC：語義有損、
prefix cache 全滅）、動態壓縮（分代 GC：熱區原文保 cache，冷區確定性投影——
taucode 的 send-time projection 已驗證此檔,其改進方向是 summary-at-read：
摘要在讀取時帶意圖預付，而非驅逐時無方向補產；代碼的正確摘要是符號圖不是
embedding）、subagent 分發（fork + 值傳遞：構造性隔離、可並行、全額冷啟動稅）。
三者非互斥,混合體：父 context 動態壓縮保熱區、機械任務留父側、判斷/風險任務
帶壓縮參數包 fork。本輪的分層策略即此混合體的粗糙實現。

後續：計劃在成熟 harness（Pi agent）上只動 compaction 策略做對照實驗
（配對 task packets、報告 re-read count / completion rate / token 分佈）。
Mnemos 提供 subagent 側的實證案例，taucode 提供投影機制,Pi 輪合題。
誠實預期：也可能什麼都測不出——工作語義建立失敗、反覆讀文件、依賴 base
model 能力，皆有可能；帶完整觀測面的陰性結果同樣是結果。
