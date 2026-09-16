/** 四方牌桌：外圈手牌、内圈副露、中央牌河与方向盘。 */
export function installTableLayout(): void {
  const style = document.createElement("style");
  style.textContent = `
    main{max-width:1680px;width:100%;padding:12px;overflow:auto}
    #board{position:relative;display:block;width:min(100%,calc((100dvh - 90px)*16/9));margin:0 auto;min-width:960px;aspect-ratio:16/9;background:radial-gradient(ellipse at center,#205a49,#123d32 65%,#102d26);border:10px solid #493b29;border-radius:28px;box-shadow:inset 0 0 0 2px #947c4b,inset 0 0 80px #061b1690;overflow:hidden;container-type:size}
    #board .seat,#board .seat-card,#board .tiles-area,#board .center{display:contents}
    #board .seat-card>.hint{display:none}
    #board .hand,#board .seat>.seat-card>.seat-head,#board .seat-card>.ops,#board .tiles-area>.melds{position:absolute;margin:0}
    #board .hand{display:flex;gap:4px;flex-wrap:nowrap;align-items:center;justify-content:center;overflow:visible;max-height:none}
    #board button.tile{min-width:0;padding:0;width:calc((100% - 52px)/14);height:100%;max-height:72px;border-radius:5px;box-shadow:0 4px 0 #b6b099,0 6px 8px #0004;font-size:clamp(15px,2vw,29px);flex-shrink:1}
    #board button.tile:disabled{opacity:1;cursor:default}
    #board button.tile.missing-suit{opacity:.55}
    #board button.tile.chosen{transform:translateY(-8px);background:#f2bd4d}
    #board .seat.bottom .hand{left:12%;top:84%;width:76%;height:8%}
    #board .seat.top .hand{left:26%;top:6%;width:48%;height:5.5%}
    #board .seat.top button.tile{font-size:clamp(12px,1.5vw,22px)}
    /* 左右两家竖排手牌。
       牌的宽度不能写成 100%：这一列是百分比宽，牌会被拉成 3:1 的长条
       （量过：60.7×20.8，而上下两家是 37.9×37.1 / 62.2×53.9）。
       改成让宽度跟着高度走，比例才和其他两家一致。 */
    #board .seat.left .hand,#board .seat.right .hand{top:21%;width:2.6%;height:49%;flex-direction:column;gap:3px;overflow:visible}
    #board .seat.left .hand{left:16%}#board .seat.right .hand{right:16%}
    #board .seat.left button.tile,#board .seat.right button.tile{width:auto;aspect-ratio:1.15;height:calc((100% - 39px)/14);font-size:clamp(8px,.8vw,12px);flex:none;box-shadow:2px 2px 0 #b6b099}
    #board .seat.left button.tile.chosen{transform:translateX(8px)}#board .seat.right button.tile.chosen{transform:translateX(-8px)}
    #board .tiles-area>.melds{display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid #c9ab6533;background:#071e1733;border-radius:8px;padding:4px;min-height:5%}
    #board .seat.top .tiles-area>.melds{left:29%;top:20%;width:42%;height:6%}
    #board .seat.bottom .tiles-area>.melds{left:27%;top:73%;width:46%;height:6%}
    /* 内圈碰杠：左右两家跟着手牌竖着摆 —— 组与组竖排，**组内也竖排**。
       横着摆和这一列的方位不符（左侧那副会横在手牌旁边），所以钉死 column。
       牌块高度用 cqh（1% 牌桌高）算，和手牌同一个公式，缩放时才不会各走各的。 */
    #board .seat.left .tiles-area>.melds,#board .seat.right .tiles-area>.melds{top:21%;height:49%;width:2.6%;flex-direction:column;flex-wrap:nowrap;justify-content:flex-start;overflow:auto}
    #board .seat.left .tiles-area>.melds{left:19%;width:2.6%}#board .seat.right .tiles-area>.melds{right:19%;width:2.6%}
    #board .seat.left .meld-group,#board .seat.right .meld-group{flex-direction:column}
    #board .seat.left .meld-group .kind,#board .seat.right .meld-group .kind{display:none}
    #board .seat.left .meld-group .chip,#board .seat.right .meld-group .chip{width:auto;aspect-ratio:1.15;height:17px;height:calc((49cqh - 39px)/14*.8);font-size:clamp(8px,.8vw,12px);white-space:nowrap}
    #board .seat.top .tiles-area>.melds,#board .seat.bottom .tiles-area>.melds{flex-wrap:nowrap}
    #board .seat.top .meld-group .kind,#board .seat.bottom .meld-group .kind{display:none}
    #board .seat.top .meld-group .chip,#board .seat.bottom .meld-group .chip{width:clamp(17px,1.8vw,25px);height:28px;font-size:11px;white-space:nowrap}
    #board .meld-group{padding:3px;background:#0b2b22;border-color:#b59a5660}
    #board .chip{width:clamp(19px,2vw,29px);height:clamp(22px,2.3vw,33px);font-size:clamp(10px,1vw,15px);box-shadow:0 2px 0 #afa58e}
    #board .seat-head{justify-content:center;font-size:12px;gap:5px;margin:0;color:#e2d7b6}
    #board .seat.bottom .seat-head{left:20%;top:80%;width:60%}
    #board .seat.top .seat-head{left:22%;top:2%;width:56%}
    #board .seat.left .seat-head{left:2%;top:13%;width:22%}#board .seat.right .seat-head{right:2%;top:13%;width:22%}
    #board .seat-card>.ops{justify-content:center;z-index:3;max-height:9%;overflow:auto;background:#09271ee8;padding:4px;border:1px solid #b79a59;border-radius:8px;box-shadow:0 3px 10px #0005}
    #board .seat.bottom .ops{left:20%;top:79%;width:60%}#board .seat.top .ops{left:26%;top:0.5%;width:48%}
    #board .seat.left .ops{left:8%;top:12%;width:20%}#board .seat.right .ops{right:8%;top:12%;width:20%}
    #board .ops button{font-size:12px;padding:5px 9px}#board .ops .hint{font-size:11px}
    #board .seat-card>.error{position:absolute;bottom:0;left:25%;font-size:11px}
    #center>.banner{position:absolute;left:30%;top:27%;width:40%;z-index:2;font-size:12px;padding:3px;text-align:center;background:transparent;border:0;color:#e7cf98}
    #center>.meta,#center>.hint{display:none}
    #center>.ops{position:absolute;left:30%;top:66%;width:40%;justify-content:center;z-index:4}
    #board .discard-grid{position:absolute;left:28%;top:31%;width:44%;height:38%;display:grid;grid-template:29% 42% 29% / 28% 44% 28%;gap:4px;margin:0}
    #board .discard-cell{padding:3px;background:#ffffff04;border:1px solid #e9e3c512;border-radius:6px;overflow:auto}
    #board .discard-cell.top{grid-area:1/1/2/4}#board .discard-cell.bottom{grid-area:3/1/4/4}
    #board .discard-cell.left{grid-area:2/1/3/2}#board .discard-cell.right{grid-area:2/3/3/4}
    #board .discard-head{display:none}#board .discard-tiles{justify-content:center;gap:3px;margin:0}
    #board .discard-cell .chip{width:clamp(17px,1.6vw,25px);height:clamp(21px,2vw,30px);font-size:clamp(9px,.85vw,12px);white-space:nowrap}
    .table-hub{position:absolute;left:43%;top:43%;width:12%;height:15%;background:linear-gradient(145deg,#174335,#0d2921);border:2px solid #b7a26b;border-radius:14px;box-shadow:0 6px 15px #0005;display:grid;grid-template:25% 50% 25% / 25% 50% 25%;text-align:center;align-items:center;color:#b9bca0}
    .wind{font-size:clamp(15px,1.8vw,25px);font-weight:bold}.wind.active{color:#ffe39b;text-shadow:0 0 12px #eab842}
    .wind.bottom{grid-area:3/2}.wind.right{grid-area:2/3}.wind.top{grid-area:1/2}.wind.left{grid-area:2/1}
    .turn-clock{grid-area:2/2;font-size:clamp(24px,3vw,44px);font-weight:700;font-variant-numeric:tabular-nums;color:#f8eac6}.turn-clock.urgent{color:#ff967f}
    .wall-counter{position:absolute;left:55.5%;top:46%;width:4%;height:9%;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #77a8bd77;border-radius:8px;background:#143e4c;color:#c5e7ec;font-size:11px}.wall-counter strong{font-size:clamp(19px,2vw,30px)}
    .center-status{display:none;position:absolute;left:40%;top:59%;width:20%;text-align:center;color:#a6c3b6;font-size:11px}
    #center>.room-no{position:absolute;left:35%;top:35%;width:30%;text-align:center}
    #board .player-profile{position:absolute;width:7%;z-index:2;text-align:center}
    #board .seat.top .player-profile{left:76%;top:1.5%;width:6%}
    #board .seat.left .player-profile{left:4%;top:28%}
    #board .seat.right .player-profile{right:4%;top:28%}
    #board .seat.bottom .player-profile{left:4%;top:65%}
    .player-avatar{position:relative;aspect-ratio:1;background:linear-gradient(145deg,#b5b8b5,#787f7b);border:2px solid #e2e4d6;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:30px;color:#fff;overflow:hidden;box-shadow:0 3px 8px #0004}
    .player-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .round-score{margin-top:4px;padding:3px 0;border-radius:4px;background:#0a271e;font-size:clamp(11px,1.2vw,17px);font-weight:bold;font-variant-numeric:tabular-nums;white-space:nowrap}
    .round-score.win{color:#ffdc7f}.round-score.loss{color:#ff9b96}.round-score.even{color:#c5d7cd}
    .profile-name{font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d8e3d9}
    .profile-badges{position:absolute;left:calc(100% + 4px);top:0;display:flex;flex-direction:column;gap:5px}
    #board .seat.right .profile-badges{left:auto;right:calc(100% + 4px)}
    .profile-badges span{display:block;min-width:26px;font-size:11px;padding:5px 3px;border-radius:4px;white-space:nowrap}
    .dealer-badge{background:#d8ad47;color:#302204;font-weight:bold}.missing-badge{background:#173e35;color:#e0ece0;border:1px solid #74927b}
    #board .seat>.seat-card>.seat-head{display:none}
    @media(max-width:780px){main{padding:4px}#board{border-width:6px}#bar{font-size:12px}.key-row input.text{min-width:0}.key-row{flex-wrap:nowrap}}
  `;
  document.head.append(style);
}
