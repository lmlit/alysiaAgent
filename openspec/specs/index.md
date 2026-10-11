# OpenSpec 鈥?Spec 绱㈠紩

> 娲荤殑 spec 鎬荤储寮曘€?*鏂板姛鑳藉疄鐜板墠鍏堟煡杩欓噷**锛涗换浣曞彉鏇村厛鐪嬪搴?spec 鏄惁宸茶鐩栥€?
> 鐘舵€侊細`active` = 浠嶅湪婕旇繘锛屾敼鍔ㄩ渶璧?change锛沗frozen` = 宸插疄鐜颁笖涓嶆紨杩涳紝鍙鍙傝€冦€?
> 绱㈠紩鐘舵€佷笌 `openspec/archive/`銆乣openspec/changes/` 鑱斿姩锛屾瘡娆?archive 蹇呴』鏇存柊鏈〃銆?

| slug | 绯荤粺 | 鐘舵€?| 鏉ユ簮锛堟棫鏂囨。锛?| 鏈€鍚庡彉鏇?|
|------|------|------|----------------|----------|
| memory-system | 璁板繂绯荤粺锛? store / 3 engine / 3 processor / 鏃嬮挳锛?| active | docs/superpowers/specs/2026-06-28-memory-system-design.md | 2026-10-11 **SessionEnd 绐楀彛閿氱偣濂戠害 搂5.4.1**锛坄fix-session-end-window`锛歚onSessionEnd` / `extractProfile` 婕忎紶 `since` 鈫?钀藉埌銆屽叏鍘嗗彶鏈€杩?1000 鏉°€嶏紝绾夸笂瀹炴祴 76% 绐楀彛璺ㄥ害 > 24h銆?9 鏉℃伆濂?1000 鏉℃秷鎭法搴?**46~61 澶?*銆?5 绉掑唴杩炴憳涓夋潯锛涗笁鍏ュ彛鏀舵暃鍒板敮涓€閿氱偣 helper锛夛紱**璁板繂閾捐矾瑙傛祴濂戠害 搂4.1.3**锛坄instrument-memory-llm`锛歚al:memory-llm` 鏄嫭绔嬩簬 provider 鐨勭浜屼釜 LLM 瀹㈡埛绔€佹鍓?*闆舵棩蹇?*锛屾憳瑕佹Ы鐨勫け璐ュ洜姝や笉鍙娴?鈫?琛?`[LLM:memory]` 鐨?`tokens=`/`finish=`/`reasoning=` + 绌哄搷搴?warn锛涘悓鏃朵慨姝?搂4.1.2銆屾墍鏈夋Ы浣嶉兘娴佺粡 provider銆嶇殑閿欒鍓嶆彁锛夛紱2026-10-02 **闆惰鍐欏叆瑙傛祴 搂4.7 濂戠害 3**锛坄observe-zero-row-writes`锛歚traceZeroRows` 鍙娴嬩笉鎷︽埅锛岄噰闆?`changes===0` 鍒嗗竷锛屽喅绛栧叆鍙?`tune-zero-row-checks`锛夛紱**瀛樺偍鍐欏叆鐣欑棔濂戠害 搂4.7**锛坄fix-migration-and-logger-silent-failure`锛氳縼绉绘敼鎺㈡祴寮忓箓绛夈€佸幓鎺?13 澶勮８ catch锛涙棩蹇楀瓙绯荤粺鑷韩澶辫触蹇呴』鍠婂嚭鏉ワ級锛?*鎺ㄧ悊棰勭畻瑙傛祴濂戠害 搂4.1.2**锛坄add-llm-budget-observability`锛歱rovider 閫忓嚭 `finish_reason`/`reasoning_tokens`锛岀┖鍝嶅簲鍗曠嫭鍙锛宍role:'err'` 涓嶅啀琚帇鎴愮┖涓诧級锛?0-01 **鐢诲儚鎻愬彇闈欓粯鍋滄憜淇**锛堥噰鏍锋Ы濂戠害 搂4.1.1锛歮ax_tokens 鍏变韩棰勭畻 / json_object 鎸夎緭鍑哄绾﹀垎绫?/ 绗笁鍙傚繀椤荤敓鏁?/ 绂佽８ catch锛? 涓己闄凤級锛?9-27 瀛橀噺鍥炲～锛?2 鏉″崰浣嶇鎽樿閲嶇敓鎴?+ 40 鏉″瀮鍦惧悜閲忔浛鎹?+ 77 鏉＄己澶卞悜閲忚ˉ榻愶紱`getBySession` 鍔?`until`锛夛紱09-26 浜嬩欢绐楀彛鎴柇淇锛?9-25 鎽樿闈欓粯澶辫触淇涓庡嚟鎹缃紱**09-25 鍙洖绠￠亾涓夌己闄蜂慨澶?*锛坄optimize-recall-pipeline`锛歝osine 鍒诲害閫€鍖?/ `mergeWithQuota` 璺ㄦ潵婧愰厤棰?/ `RELATIVE_KEEP` 鐩稿闃堝€煎幓閲嶏級+ **`importance` 鎺ョ嚎**锛坄wire-importance-signal`锛?|
| alysia-architecture | 鎬讳綋鏋舵瀯锛坢onorepo / 鍙屾ā寮忥級 | active | docs/superpowers/specs/2026-07-20-alysia-architecture-design.md | 2026-10-02 **鍒犻櫎 packages/webui**锛坮emove-packages-webui锛氱洰褰曟爲鍘?webui 琛屻€佸钩鍙拌〃鏀广€宑onsole 鍞竴銆嶏級+ **缂栫▼妯″紡鐢?dsh 鎵挎帴**锛坮ecord-dsh-as-coding-mode锛屼慨姝ｃ€岀爫鎺夌紪绋嬫ā寮忋€嶏級锛?0-01 妯″潡鍖栬閰嶏紙module-kernel锛歝ore 13 妯″潡 + server 10 妯″潡锛夛紱**09-25 鐮嶆帀 Electron 妗岄潰绔?*锛坉rop-electron-desktop锛夛紱08-15 WebUI 鑱婂ぉ绔偣 + LLM 娴佸紡濂戠害 |
| pipeline-contract | Pipeline 濂戠害 + 璁板繂淇 | frozen | docs/superpowers/specs/2026-07-30-pipeline-contract-and-memory-fix.md | 2026-08-07 杩佺Щ |
| server-desktop-separation | 鏈嶅姟绔?妗岄潰绔垎绂?| frozen | docs/superpowers/specs/2026-07-30-server-desktop-separation.md | 2026-08-07 杩佺Щ |
| server-optimization | 鏈嶅姟绔紭鍖栵紙娴佸紡/stop/WebUI 寰呭仛椤癸級 | frozen | docs/superpowers/specs/2026-07-30-server-optimization.md | 2026-08-07 杩佺Щ |
| knowledge-base-import | 鐭ヨ瘑搴撳鍏?| frozen | docs/superpowers/specs/2026-07-31-knowledge-base-import.md | 2026-08-07 杩佺Щ |
| role-system | v3 瑙掕壊绯荤粺锛坕mport/export/active锛?| active | docs/superpowers/specs/2026-07-31-role-system.md | 2026-10-01 **淇 importRole 娓呯┖浜鸿**锛堟敼鎸夊瓧娈靛悎骞讹紱琛ㄦ儏鍖呰鑹插寘鏇炬瘡娆″惎鍔ㄥ啿鎺夋様娑熺殑 system_prompt锛宑hange: fix-role-import-wipes-persona锛夛紱08-07 杩佺Щ |
| domestic-search-weather | 鍥藉唴鎼滅储 + 澶╂皵 | frozen | docs/superpowers/specs/2026-08-02-domestic-search-weather.md | 2026-08-07 杩佺Щ |
| logging-system | 鏃ュ織绯荤粺锛堟湰鍦版椂闂?鏂囦欢鎸佷箙鍖栵級 | frozen | docs/superpowers/specs/2026-08-02-logging-system.md | 2026-08-07 杩佺Щ |
| proactive-messages | 涓诲姩娑堟伅锛堟椂娈甸棶鍊?鑺傛棩/鍏虫€€锛?| active | docs/superpowers/specs/2026-08-02-proactive-messages.md | 2026-08-09 鍥炲啓+瀵硅瘽涓婁笅鏂囷紙璁板繂闂幆锛?|
| profile-fact-sourcing | 鐢诲儚浜嬪疄婧簮 | frozen | docs/superpowers/specs/2026-08-02-profile-fact-sourcing.md | 2026-08-07 杩佺Щ |
| qq-reconnect-backoff | QQ 閲嶈繛閫€閬?| frozen | docs/superpowers/specs/2026-08-02-qq-reconnect-backoff.md | 2026-08-07 杩佺Щ |
| role-memory-isolation | 瑙掕壊璁板繂闅旂 | 鎼佺疆 | docs/superpowers/specs/2026-08-02-role-memory-isolation.md | 2026-08-07 杩佺Щ |
| server-hardening | 鏈嶅姟绔姞鍥?| active | docs/superpowers/specs/2026-08-02-server-hardening.md | 2026-09-25 閴存潈瑙﹀彂鏉′欢鏀逛负璺熼殢缁戝畾鍦板潃锛坄server-bind-host`锛屽洖鐜厤閴存潈锛? 9-24 閽╁瓙鑼冨洿淇锛堝彧瀹?/api/*锛?|
| sticker-protocol | 琛ㄦ儏鍖呭崗璁?| frozen | docs/superpowers/specs/2026-08-02-sticker-protocol.md | 2026-08-07 杩佺Щ |
| tool-call-text-strip | 宸ュ叿璋冪敤鏂囨湰鍓ョ | frozen | docs/superpowers/specs/2026-08-02-tool-call-text-strip.md | 2026-08-07 杩佺Щ |
| ai-life-system | AI 涓诲姩鐢熸椿绯荤粺锛圠ifeService锛?| active | docs/superpowers/specs/2026-08-06-ai-life-system-design.md | 2026-10-02 **浜嬩欢鐢熸垚閾捐矾鏃ュ織濂戠害**锛坄add-llm-budget-observability`锛氭Ы浣嶇骇 `finish/tokens/reasoning/content` 鐜板満 + 璋冪敤澶辫触涓嶅啀浼鎴?妯″瀷娌¤緭鍑?锛夛紱10-01 鎻愮ず璇嶈祫浜ф惉鍒?`packages/server/src/prompts/`锛坋xternalize-life-prompts锛屽惈銆屼负浣曚笉鍋?.md銆嶅垽鎹?+ 7 鏉″畧鍗級锛?8-31 姣忔棩鍙嶆€濋棴鐜紙L3 鑷慨鏀规墽琛屽櫒锛?|
| vision-bridge | 鍥剧墖璇嗗埆锛圙LM-4V-Flash 鎻忚堪锛?| frozen | 锛堟棤鏃ф枃妗ｏ紝2026-08-07 琛ワ級 | 2026-08-07 鏂板缓 |
| webui-system | WebUI 鍓嶇锛圴ue SPA/涓婚/绠＄悊闈㈡澘/鑱婂ぉ瑙嗗浘锛?| **frozen**锛堝寘宸插垹闄わ級 | 锛堟棤鏃ф枃妗ｏ紝2026-08-15 琛ワ級 | 2026-10-02 **鍖呮暣浣撳垹闄?*锛坄remove-packages-webui`锛?4 鏂囦欢 git rm锛沗defaultDist` 鍥炶惤涓?`isDesktop` 鍓嶇闂ㄧЩ闄わ紝缂轰骇鐗╂敼**鏄惧紡 warn**锛涙墽琛屽墠瀹¤鎺ㄧ炕浜?缃插悕娈嬬暀"涓?姝诲垎鏀?涓ゆ潯绔嬮」璇存硶锛? 椤圭鐞嗚兘鍔涢檷绾?API-only锛岃璇?change 閬楃暀琛級銆傚巻鍙诧細09-25 闈欐€佹墭绠″彲鍒囨崲锛坄console-local-serve`锛? 鍒?Electron 澹筹紙`drop-electron-desktop`锛? 杩佸嚭 Live2D锛坄migrate-live2d-to-console`锛夛紱09-24 璧风敱 `alysia-console` 鍙栦唬銆俙webui-visual-redesign` 宸叉爣 `superseded` |
| reminder-tool | 鎻愰啋宸ュ叿锛坰et/list/cancel + 鎺ㄩ€侊級 | active | 锛堟棤鏃ф枃妗ｏ紝2026-08-07 琛ワ級 | 2026-08-12 SQLite 鎸佷箙鍖栵紙閲嶅惎鎭㈠锛岃繃鏈熻ˉ鍙戯級 |
| dsh-adapter | DSH 鎻掍欢閫傞厤灞傦紙鏄旀稛浜烘牸/璁板繂鎺ュ叆 DeepSeek Harness锛?| active | 锛堟棤鏃ф枃妗ｏ紝2026-08-25 琛ワ級 | 2026-10-01 bundle 鍖栵紙`dsh.bundle.patch` + preset 澹版槑锛屼汉璁炬敼璧?`{{alysia_persona}}` 鍙橀噺鍙垏鎹紱preset 娲剧敓鑷?standard 浠ヤ繚浣忓伐鍏烽泦锛? **鍙岃繘绋嬮€氶亾钀藉湴**锛坄POST /api/ingest` / `GET /api/persona/prompt`锛宑hange: connect-dsh-alysia-bridge锛夛紱10-02 **璇婚€氶亾琛ラ綈**锛坄POST /api/memory/read` + 鎻掍欢缂撳瓨/棰勭儹 + recall_memory 鐪熷伐鍏凤紝change: bridge-memory-read锛夛紱10-02 **瀛?agent 浼氳瘽杩囨护**锛坄header.origin === 'subagent'` 涓€寰嬩笉鍥炰紶/涓嶇粨绠椻€斺€斾慨瀛?agent 鍐呭姹℃煋浜烘牸涓庣敾鍍忥紝change: exclude-subagent-sessions-from-bridge锛夛紱10-01 bundle 鍖?+ 鍐欓€氶亾锛?8-25 MVP 楠岃瘉闂幆 |
| alysia-console | 鏄旀稛鎺у埗鍙?路 Next.js 鏂板墠绔紙璁捐绯荤粺/API 灞?閫傞厤灞?閮ㄧ讲褰㈡€侊級 | active | 锛堟棤鏃ф枃妗ｏ紝2026-09-24 寤猴級 | 2026-09-25 闆嗕腑钀藉湴锛歚adopt-nextjs-console`锛堟敹缂?+ 鐪熸暟鎹級銆乣console-local-serve`锛堟湇鍔＄鍚屾簮鎵樼 + 鍥炵幆鍏?token锛夈€乣deploy-console-remote`锛堣繙绔?Docker 閮ㄧ讲宸蹭笂绾匡級銆乣wire-console-chat`锛堢湡浼氳瘽 + 娴佸紡瀵硅瘽 `/api/chat/stream`锛夈€乣add-life-readonly-endpoints`锛坄/api/life/summaries` + `/companions`锛夈€乣migrate-live2d-to-console` + `live2d-persist-across-pages`锛圠ive2D 杩佸叆 + 璺ㄩ〉鎸佷箙鍖栵紝璐村浘 8192虏鈫?048虏锛夈€乣server-bind-host`锛堥壌鏉冭竟鐣岋級銆乣drop-electron-desktop`锛堝垹 `/desktop`锛夛紱**2026-10-02 鎴愪负鍞竴鍓嶇**锛坄remove-packages-webui`锛歸ebui 鍒犻櫎銆侀潤鎬佹墭绠℃敹鏁涗负鍗曞€欓€夈€佺己浜х墿鏄惧紡 warn锛?|
| module-kernel | 妯″潡鍐呮牳锛圡odule 濂戠害 / ModuleHost / 鎷撴墤鎺掑簭涓庨€嗗簭鍗歌浇锛?| active | 锛堟棤鏃ф枃妗ｏ紝2026-10-01 寤猴級 | 2026-10-01锛氭柊寤猴紙add-module-kernel锛夆啋 鍒犳帀渚濇嵁閿欒鐨?`peer` 鏈哄埗锛坉rop-kernel-peer锛夆啋 **鎺ュ叆 `AlysiaCore.start()`**锛坢odularize-core-assembly锛?3 涓ā鍧楋紝鍏紑闈笉鍙橈級銆傚绾﹀埢鎰忓仛鎴?cordis 褰㈢姸锛屼负 dsh 杩佺Щ閾鸿矾锛?0-01 妯″潡绾у崟娴?28 鐢ㄤ緥锛坅dd-module-tests锛夛紱**server 渚?bootstrap 鎷嗘垚 10 涓ā鍧?*锛坢odularize-server-assembly锛屾娊鍑?PushChannel锛?|

## 馃搶 Backlog锛坉oc 宸插０鏄庛€乮mpl 鏈帴锛岃褰曞湪妗堜笉闅愬舰锛?

| change | 璇存槑 | 鏂瑰悜 |
|--------|------|------|
| [worldbook-sampling-cooldown](../changes/worldbook-sampling-cooldown/proposal.md) | ai-life 搂6/7 涓栫晫涔﹂噰鏍风己 cooldown 杩囨护锛堝彧鍋氫簡 priority 鎺掑簭 + hit_count锛?| docs 鈫?impl锛堣ˉ瀹炵幇锛宻pec 涓嶆敼锛?|
| [add-platforms-endpoint](../changes/add-platforms-endpoint/proposal.md) | Web-API 搂3.4 `GET /api/platforms` 鍏ㄤ粨搴撴棤瀹炵幇鈥斺€斿敮涓€鏂囨。浜嗕絾瀹屽叏娌″缓鐨勬帴鍙?| docs 鈫?impl锛堣ˉ瀹炵幇锛屽绾︿笉鏀癸級 |
| [console-a11y-motion](../changes/console-a11y-motion/proposal.md) | console 17 澶勬寔缁姩鐢绘棤 `prefers-reduced-motion` 瀹堝崼锛沨ero 娓愬彉鏍囬鍦?`forced-colors` 涓嬪彲鑳戒笉鍙 | 鏂板锛堥潪 doc/impl gap锛?-24 鏍告煡鍙戠幇锛夛紱鐢ㄦ埛鎸囩ず銆屽厛璁颁笅鏉ャ€嶆殏涓嶅疄鐜?|
| [tune-recall-with-runtime-data](../changes/tune-recall-with-runtime-data/proposal.md) | 鍙洖绠￠亾鐨勭郴鏁帮紙`LIFE_BASE`/`RELATIVE_KEEP`/鎯呯华璇嶈〃鈥︼級鍏ㄦ槸鍚彂寮忔媿鐨勶紝璇ョ敱杩愯鏁版嵁瀹氾紱**涓旈儴鍒嗘寚鏍囩幇鍦ㄦ棤鏃ュ織锛岃鍏堣ˉ瑙傛祴** | 鏂板锛涚敤鎴?9-25銆岃繍琛屼竴娈垫椂闂翠笂鏈嶅姟鍣ㄦ崬鏁版嵁鐪嬬湅銆?|
| [add-ops-health-report](../changes/add-ops-health-report/proposal.md) | 浼氳瘽鎽樿 **22 澶?100% 澶辫触**鏈熼棿锛屽鍣?healthcheck 涓?`/api/health` **鍏ㄧ▼涓虹豢**鈥斺€旂己鐨勬槸姝ｇ‘鎬ф寚鏍囷紙鎽樿鎴愬姛鐜?鍚勬ā鍧?WARN 璁℃暟锛夛紝涓嶆槸瀛樻椿鎸囨爣 | 鏂板锛堝彲瑙傛祴鎬э級锛?*鐢ㄦ埛 9-25 鍐冲畾鍏堣妗ｅ悗鍋?*锛涘墠缃細鏃ュ織绯荤粺鍏堟暣鐞嗭紙96.6% 鏄?QQ 鍣０锛?|
| [clean-spec-diff-residue](../changes/clean-spec-diff-residue/proposal.md) | apply 鏈幓 diff 鏍囪鐨勪骇鐗╂畫鐣欍€傗槄 **2026-10-02 澶嶆牳锛氳寖鍥存瘮绔嬮」鏃惰鐨勫ぇ** 鈥斺€?`memory-system/spec.md` 5 琛岋紙`persona-overlay-perspective`锛夈€乣ai-life-system/spec.md` **绾?42 琛?*锛坄worldbook-digest-summary` / `life-interval-narrative` / `chat-life-continuity` / `mood-side-analysis` / `worldview-crossworld-window` / `life-event-message-split` / `worldview-base-field` 绛夊娆?apply 灞傚眰绱Н锛夈€乣alysia-console/spec.md` 1 琛?| 鏂囨。鍗敓锛涒殸锔?**涓嶈兘鐢?`grep '^\+'` 鐩存帴鍒?* 鈥斺€?寰楅€愭潯鍒ゃ€屾槸 diff 娈嬬暀杩樻槸姝ｆ枃銆嶏細`ai-life-system` 閲屾贩鐫€ ASCII 鏍戣瀛楃 `+鈹俙 涓庢彁绀鸿瘝妯℃澘姝ｆ枃 |
| [tune-zero-row-checks](../changes/tune-zero-row-checks/proposal.md) | **KI-11 鐨勫喅绛栧叆鍙?*锛氬叏 core 55 涓啓鍏ョ偣鍙湁 3 澶勬鏌?`.run().changes` 鈥斺€?銆屾敼鍒颁簡銆嶄笌銆屼粈涔堥兘娌℃敼銆嶅悓褰紙`markDelivered` 浼氬奖鍝嶉噸澶嶆帹閫併€乣PersonaStore` 8 涓?`WHERE is_active=1` 浼氭姤鍋囨垚鍔燂級銆?*瑙傛祴宸蹭笂绾?*锛坄observe-zero-row-writes` 鎵?`[WriteTrace]`锛夛紝**绛夎繍琛屾暟鎹啀閫愮偣瀹氭€?*锛氳眮鍏?/ 纭牎楠?| 鏂板锛?*鐢ㄦ埛 2026-10-02銆屽厛鎵撴棩蹇楋紝鍚庣画杩愯涓€娈垫椂闂村悗妫€鏌ュ啀鍐崇瓥銆?* |
| [fix-store-write-trace](../changes/fix-store-write-trace/proposal.md) | **瀛樺偍鍙娴嬫€х浜屽垁**锛欿I-12锛坄INSERT OR REPLACE` 鍒楀崟缂?`archived` 鈫?閲嶆姇闈欓粯澶嶆椿杞垹浼氳瘽锛? KI-13锛堢煡璇嗗簱鍗婃埅鏂囨。 + hash 鍘婚噸閿佹锛? KI-14锛坄LanceDBStore.insert` 姘镐笉鎶?鈫?涓婃父 catch 鎴愭浠ｇ爜锛?*2026-09-27 浜嬫晠鍚屽舰浠ｇ爜浠嶆椿鐫€**锛? KI-15锛坄vectorStore` null 闈欓粯璺宠繃 10 鏉¤矾寰勶級/ KI-16锛坄PersonaStore` 璇绘椂鍥炲啓榛樿鍊硷級/ KI-17 + KI-5 鍓╀綑 9 澶勮８ catch | 鏂板锛涚涓€鍒€鍙慨"鍦板熀"锛屾湰鍒€瑕?*鏀瑰垽鏂涔?*锛屽悇鑷渶鐙珛楠岃瘉 |
| [decide-life-event-max-tokens](../changes/decide-life-event-max-tokens/proposal.md) | **KI-1 鐨勬暟鎹喅绛?*锛歚life.generateEvent` 鏃?`max_tokens`锛屼笌宸茬垎涓夋鐨勬Ы鍚屽舰銆傝娴嬪凡涓婄嚎锛坧rovider `[LLM]` 琛?+ `[Life] event LLM` 琛岋級锛?*绛夋暟鎹啀瀹?*锛涢『甯﹂棴鐜?KI-2锛坄proactive.personalize` / `vision.describe`锛?| 鏂板锛?*绾緥锛氭病鏈夎娴嬪氨涓嶈鏀归绠楁暟瀛?*锛涙暟鎹樉绀哄畨鍏ㄤ篃寰楀湪 搂4.1.2 璁颁竴鍙ラ棴鐜?|
| [unify-core-shutdown](../changes/unify-core-shutdown/proposal.md) | **KI-6**锛歚core.stop()` 涓嶅叧 SQLite / LanceDB 鍙ユ焺 鈫?Windows 涓婁复鏃剁洰褰曞垹涓嶆帀锛圗PERM锛夈€傝涓哄彉鏇达紝闇€鍗曠嫭楠岃瘉 | 宸插畾鍚嶆湭寮€ change锛坄modularize-core-assembly` proposal 鍐崇瓥 2 棰勭暀锛夛紱2026-10-02 琛ョ櫥璁?|

> 馃摝 **宸查攢璐?*锛?026-10-02 鏁寸悊锛夛細`backfill-failed-session-summaries` 宸蹭簬 **2026-09-27 褰掓。**
> 锛坄openspec/archive/2026-09-27-backfill-failed-session-summaries/`锛夛紝鏈〃鍘熸湁鐨勪竴琛屽凡绉婚櫎
> 鈥斺€斿畠姝ゅ墠鏄?*姝婚摼**锛坄changes/` 涓嬪凡鏃犺鐩綍锛夈€?
> 馃棏锔?`webui-visual-redesign` 宸叉爣 `superseded`锛堥潪 backlog锛夛細鍏跺璞℃槸 Vue 鐗?webui 鐨勫竷灞€澶ф敼锛?
> 鑰?webui 宸蹭簬 2026-10-02 鏁翠綋鍒犻櫎锛坄remove-packages-webui`锛屽凡褰掓。锛夛紱8-15 璧风殑銆屾柟妗堝緟纭銆?
> 涓嶅啀鎺ㄨ繘锛屼笖浠ｇ爜閲屾煡鏃犲叾瀹炴柦钀界偣銆?
>
> 馃搵 **浠嶅湪 `docs/KNOWN-ISSUES.md` 鐧昏銆佸皻鏈紑 change 鐨勭己闄?*锛堣鍐屾槸 triage 鍏ュ彛锛屼慨涓€鏉?= 寮€涓€涓?change锛夛細
> **KI-3**锛堜袱涓?`ILLMService` 瀹炵幇鏃犱竴鑷存€у绾︽祴璇曪級銆?*KI-4**锛坄PersonaAdapter` 瑁?`JSON.parse`锛夈€?
> **KI-7**锛坄/stop` 鍙墦鏃ュ織涓嶄腑鏂級銆?*KI-8**锛堟牴鐩綍 `config.yml` 鏄鏂囦欢锛夈€?
> **KI-9**锛坄memory/services/` 鐤戜技鍗婃浠ｇ爜锛夈€?*KI-10**锛堝唴鏍哥己銆屽彧鎺掑簭涓嶄緷璧栨湇鍔°€嶇殑琛ㄨ揪鏂瑰紡锛夈€?
> **KI-21**锛堚槄 2026-10-11 鏂板锛歚al:memory-llm` **鏃犺秴鏃?* 鈥斺€?鏂綉鏃惰姹傛寕 117 鍒嗛挓涓嶆姤閿欙紱
> 鑱婂ぉ閾捐矾鏈?60s 瓒呮椂锛岃蹇嗛摼璺病鏈夛紱绾夸笂瀹炴祴 `extractProfile (7039529ms)`锛夈€?
> 浠ュ強**鍘嗗彶鐢诲儚鍥炲～**锛堢嚎涓?`basics`/`facts` 闀挎湡绋€鐤忥紝淇鍙繚璇佷粠姝ゅ線鍚庯級銆?
> 鈥斺€?**宸插紑 change 鐨勯偅鍑犳潯**锛圞I-1 / KI-5 閮ㄥ垎 / KI-6 / KI-11锝濳I-17锛夊湪涓婅〃鏈夎锛岀偣杩涘幓鍗冲彲銆?

## 鐩稿叧娲绘枃妗ｏ紙闈?spec锛屼絾鍚屼负 source of truth锛?

| 鏂囨。 | 璇存槑 |
|------|------|
| docs/Web-API-Design.md | Web 绔?API 濂戠害锛堚槄 寮€鍙戠害鏉燂細鏂板/淇敼 core 鏂规硶蹇呴』鍏堝鐓э級 |
| docs/Docker-Deployment.md | 鏈嶅姟绔増鏈洿鏂?SOP锛堥儴缃叉祦绋嬶級 |
| docs/README.md | 鍏ㄦ枃妗ｆ€荤储寮曪紙鏈枃浠朵负 spec 绱㈠紩锛孯EADME 涓烘墍鏈夋枃妗ｅ叆鍙ｏ級 |
| openspec/archive/ | 褰掓。锛氬凡瀹屾垚 change + 鏃?spec 鐗堟湰 + legacy 杩佺Щ鏂囨。 |
| openspec/changes/ | 杩涜涓?鎸傝捣鐨?change |
