import { useState, useCallback } from "react";

const KEY="5cce14f3242989037557db8157e2db7f",SPORT="baseball_mlb";
const MKT1="pitcher_strikeouts,pitcher_outs,batter_hits,batter_home_runs,batter_runs_scored,batter_rbis";
const MKT2="batter_total_bases,batter_hits_runs_rbis,batter_doubles,batter_stolen_bases,batter_strikeouts,batter_singles";
const C={bg:"#07090f",panel:"#0d1220",card:"#111827",border:"#1a2840",green:"#00e676",red:"#ff4444",yellow:"#ffd600",blue:"#40c4ff",purple:"#b388ff",orange:"#ff9100",white:"#eef2ff",muted:"#3d5270",dim:"#6b88ab"};
const PK={"Oracle Park":{runs:97,HR:88,so:102,pf:0.97},"Petco Park":{runs:98,HR:92,so:102,pf:0.98},"Daikin Park":{runs:102,HR:104,so:100,pf:1.02},"T-Mobile Park":{runs:96,HR:90,so:104,pf:0.96},"Uniqlo Field":{runs:102,HR:108,so:101,pf:1.02}};
const TC={"S+":C.green,"S":C.green,"A":C.blue,"B+":C.blue,"B":C.yellow,"B-":C.yellow,"C+":C.muted};
const BC={H:C.yellow,HR:C.red,R:C.green,RBI:C.orange,TB:C.purple,HRR:C.green,"2B":C.blue,SB:C.green,K:C.red,"1B":C.yellow};
const BPROPS=["H","HR","R","RBI","TB","HRR","2B","SB","K","1B"];
const BMKTS={H:"batter_hits",HR:"batter_home_runs",R:"batter_runs_scored",RBI:"batter_rbis",TB:"batter_total_bases",HRR:"batter_hits_runs_rbis","2B":"batter_doubles",SB:"batter_stolen_bases",K:"batter_strikeouts","1B":"batter_singles"};
const II={background:C.bg,border:"1px solid #1a2840",color:"#eef2ff",borderRadius:4,padding:"3px 5px",fontSize:10,width:52,outline:"none",fontFamily:"monospace",textAlign:"center"};

// MARCH 27 2026 SLATE - Confirmed lineups from MLB.com / RotoWire / ESPN
const GAMES=[
  {id:"nyy-sf",time:"4:35 PM ET",tv:"MLB.TV",marquee:false,away:"NYY",home:"SF",venue:"Oracle Park",
   ap:{name:"Cam Schlittler",hand:"R",tier:"B-",era:3.82,fip:3.96,whip:1.24,kp:26.8,gb:44.2,projK:5.2,projO:15,projH:4.8,projER:2.1,projBB:3,note:"NYY #2. Oracle heavy suppressor (runs 97, HR 88)."},
   hp:{name:"Robbie Ray",hand:"L",tier:"B+",era:3.18,fip:3.34,whip:1.14,kp:29.2,gb:42.8,projK:6.7,projO:18,projH:4.0,projER:1.7,projBB:3,note:"SFG ace. Post-TJ resurgence. Oracle elite pitcher park."},
   // NYY confirmed OD lineup (vs RHP Ray)
   ab:[
     {n:1,name:"Trent Grisham",b:"L",pos:"CF",g:128,pa:458,h:111,s:68,d:22,hr:16,sb:21,k:102,r:68,rbi:52,tb:185,epa:4.8},
     {n:2,name:"Jazz Chisholm Jr.",b:"S",pos:"2B",g:141,pa:528,h:134,s:80,d:28,hr:24,sb:28,k:138,r:88,rbi:74,tb:246,epa:4.6},
     {n:3,name:"Aaron Judge",b:"R",pos:"RF",g:148,pa:568,h:148,s:74,d:30,hr:44,sb:8,k:138,r:98,rbi:112,tb:318,epa:4.4},
     {n:4,name:"Giancarlo Stanton",b:"R",pos:"DH",g:124,pa:448,h:108,s:60,d:22,hr:32,sb:1,k:148,r:68,rbi:88,tb:228,epa:4.3},
     {n:5,name:"Cody Bellinger",b:"L",pos:"LF",g:131,pa:481,h:118,s:72,d:24,hr:20,sb:12,k:118,r:64,rbi:66,tb:202,epa:4.1},
     {n:6,name:"Ryan McMahon",b:"L",pos:"3B",g:138,pa:508,h:118,s:68,d:26,hr:18,sb:6,k:142,r:62,rbi:66,tb:198,epa:4.0},
     {n:7,name:"Ben Rice",b:"L",pos:"1B",g:118,pa:424,h:98,s:58,d:22,hr:16,sb:2,k:124,r:52,rbi:56,tb:168,epa:3.9},
     {n:8,name:"José Caballero",b:"R",pos:"SS",g:121,pa:431,h:96,s:60,d:18,hr:10,sb:22,k:118,r:56,rbi:42,tb:144,epa:3.8},
     {n:9,name:"Austin Wells",b:"L",pos:"C",g:118,pa:421,h:98,s:62,d:20,hr:18,sb:4,k:112,r:52,rbi:58,tb:172,epa:3.7},
   ],
   // SFG confirmed OD lineup (vs RHP Schlittler)
   hb:[
     {n:1,name:"Matt Chapman",b:"R",pos:"3B",g:141,pa:528,h:128,s:72,d:28,hr:22,sb:8,k:148,r:72,rbi:74,tb:222,epa:4.8},
     {n:2,name:"Luis Arraez",b:"L",pos:"2B",g:148,pa:568,h:176,s:120,d:34,hr:8,sb:4,k:24,r:84,rbi:68,tb:242,epa:4.6},
     {n:3,name:"Rafael Devers",b:"L",pos:"1B",g:148,pa:568,h:148,s:74,d:36,hr:36,sb:2,k:148,r:88,rbi:102,tb:296,epa:4.4},
     {n:4,name:"Willy Adames",b:"R",pos:"SS",g:138,pa:511,h:121,s:66,d:26,hr:24,sb:12,k:148,r:68,rbi:74,tb:219,epa:4.3},
     {n:5,name:"Patrick Bailey",b:"S",pos:"C",g:114,pa:404,h:88,s:54,d:18,hr:10,sb:2,k:104,r:44,rbi:46,tb:146,epa:4.1},
     {n:6,name:"Heliot Ramos",b:"R",pos:"LF",g:121,pa:434,h:104,s:62,d:22,hr:17,sb:8,k:118,r:56,rbi:58,tb:177,epa:4.0},
     {n:7,name:"Casey Schmitt",b:"R",pos:"3B",g:114,pa:404,h:91,s:56,d:18,hr:12,sb:4,k:108,r:44,rbi:46,tb:145,epa:3.9},
     {n:8,name:"Jung Hoo Lee",b:"L",pos:"CF",g:138,pa:511,h:138,s:92,d:28,hr:8,sb:14,k:72,r:68,rbi:52,tb:198,epa:3.8},
     {n:9,name:"Bryce Eldridge",b:"R",pos:"DH",g:52,pa:188,h:22,s:12,d:4,hr:4,sb:0,k:62,r:10,rbi:14,tb:42,epa:3.7},
   ]},
  {id:"laa-hou",time:"8:10 PM ET",tv:"Apple TV+",marquee:false,away:"LAA",home:"HOU",venue:"Daikin Park",
   ap:{name:"José Soriano",hand:"R",tier:"B-",era:3.82,fip:3.98,whip:1.24,kp:27.2,gb:44.2,projK:5.5,projO:15,projH:4.8,projER:2.4,projBB:3,note:"LAA ace. Power arm, developing command."},
   hp:{name:"Hunter Brown",hand:"R",tier:"B+",era:3.04,fip:3.22,whip:1.08,kp:29.2,gb:45.8,projK:6.2,projO:17,projH:4.2,projER:1.9,projBB:3,note:"HOU ace. Sub-3 ERA since Apr 2024. 3rd AL Cy 2025."},
   ab:[
     {n:1,name:"Zach Neto",b:"R",pos:"SS",g:131,pa:481,h:114,s:68,d:24,hr:16,sb:18,k:124,r:62,rbi:58,tb:186,epa:4.8},
     {n:2,name:"Nolan Schanuel",b:"L",pos:"1B",g:138,pa:511,h:128,s:82,d:28,hr:14,sb:4,k:104,r:64,rbi:62,tb:198,epa:4.6},
     {n:3,name:"Mike Trout",b:"R",pos:"CF",g:120,pa:441,h:111,s:60,d:22,hr:26,sb:10,k:114,r:72,rbi:72,tb:211,epa:4.4},
     {n:4,name:"Jorge Soler",b:"R",pos:"DH",g:128,pa:461,h:108,s:62,d:22,hr:28,sb:2,k:148,r:62,rbi:82,tb:216,epa:4.3},
     {n:5,name:"Jo Adell",b:"R",pos:"LF",g:124,pa:444,h:104,s:60,d:22,hr:22,sb:12,k:138,r:58,rbi:62,tb:192,epa:4.1},
     {n:6,name:"Yoán Moncada",b:"S",pos:"3B",g:114,pa:404,h:94,s:56,d:20,hr:12,sb:6,k:114,r:48,rbi:48,tb:150,epa:4.0},
     {n:7,name:"Logan O'Hoppe",b:"R",pos:"C",g:114,pa:404,h:96,s:60,d:20,hr:14,sb:4,k:104,r:48,rbi:54,tb:158,epa:3.9},
     {n:8,name:"Christian Moore",b:"R",pos:"2B",g:101,pa:358,h:82,s:52,d:16,hr:10,sb:8,k:104,r:44,rbi:40,tb:128,epa:3.8},
     {n:9,name:"Josh Lowe",b:"L",pos:"RF",g:118,pa:421,h:96,s:62,d:20,hr:12,sb:14,k:118,r:52,rbi:44,tb:152,epa:3.7},
   ],
   hb:[
     {n:1,name:"Jose Altuve",b:"R",pos:"2B",g:138,pa:521,h:148,s:96,d:28,hr:22,sb:14,k:94,r:88,rbi:68,tb:248,epa:4.8},
     {n:2,name:"Yordan Alvarez",b:"L",pos:"DH",g:131,pa:488,h:134,s:72,d:26,hr:35,sb:2,k:114,r:86,rbi:102,tb:265,epa:4.6},
     {n:3,name:"Alex Bregman",b:"R",pos:"3B",g:138,pa:518,h:131,s:78,d:28,hr:20,sb:6,k:98,r:74,rbi:76,tb:219,epa:4.4},
     {n:4,name:"Jeremy Peña",b:"R",pos:"SS",g:138,pa:511,h:121,s:72,d:26,hr:18,sb:12,k:118,r:64,rbi:68,tb:201,epa:4.3},
     {n:5,name:"Mauricio Dubón",b:"R",pos:"CF",g:118,pa:421,h:98,s:62,d:18,hr:10,sb:14,k:92,r:52,rbi:44,tb:146,epa:4.1},
     {n:6,name:"Yainer Diaz",b:"R",pos:"C",g:124,pa:444,h:108,s:68,d:22,hr:16,sb:2,k:96,r:54,rbi:60,tb:178,epa:4.0},
     {n:7,name:"Chas McCormick",b:"R",pos:"LF",g:118,pa:421,h:98,s:62,d:18,hr:14,sb:12,k:118,r:54,rbi:50,tb:158,epa:3.9},
     {n:8,name:"Jake Meyers",b:"R",pos:"RF",g:114,pa:401,h:92,s:58,d:18,hr:10,sb:10,k:108,r:46,rbi:42,tb:140,epa:3.8},
     {n:9,name:"Victor Caratini",b:"S",pos:"C",g:101,pa:354,h:82,s:52,d:16,hr:8,sb:1,k:76,r:36,rbi:38,tb:122,epa:3.7},
   ]},
  {id:"det-sd",time:"9:40 PM ET",tv:"MLB.TV",marquee:true,away:"DET",home:"SD",venue:"Petco Park",
   ap:{name:"Framber Valdez",hand:"L",tier:"A",era:2.98,fip:3.14,whip:1.10,kp:26.4,gb:58.8,projK:6.1,projO:18,projH:4.2,projER:1.8,projBB:3,note:"DET debut. Elite 58.8% GB — Petco amplifies. Former HOU ace."},
   hp:{name:"Michael King",hand:"R",tier:"B+",era:3.12,fip:3.28,whip:1.08,kp:28.8,gb:44.2,projK:6.4,projO:17,projH:4.2,projER:1.9,projBB:3,note:"SDP solid. Petco SO+2%, HR-8%."},
   ab:[
     {n:1,name:"Matt Vierling",b:"R",pos:"CF",g:138,pa:511,h:128,s:80,d:26,hr:18,sb:14,k:112,r:68,rbi:58,tb:216,epa:4.8},
     {n:2,name:"Riley Greene",b:"L",pos:"LF",g:141,pa:528,h:138,s:82,d:30,hr:22,sb:16,k:128,r:78,rbi:72,tb:242,epa:4.6},
     {n:3,name:"Spencer Torkelson",b:"R",pos:"1B",g:148,pa:558,h:138,s:74,d:28,hr:31,sb:2,k:148,r:78,rbi:92,tb:263,epa:4.4},
     {n:4,name:"Colt Keith",b:"L",pos:"3B",g:138,pa:511,h:128,s:76,d:28,hr:21,sb:6,k:118,r:64,rbi:72,tb:223,epa:4.3},
     {n:5,name:"Gleyber Torres",b:"R",pos:"2B",g:131,pa:481,h:118,s:72,d:24,hr:16,sb:8,k:112,r:62,rbi:62,tb:190,epa:4.1},
     {n:6,name:"Dillon Dingler",b:"R",pos:"C",g:108,pa:381,h:88,s:54,d:18,hr:14,sb:2,k:104,r:44,rbi:48,tb:150,epa:4.0},
     {n:7,name:"Parker Meadows",b:"L",pos:"RF",g:108,pa:378,h:86,s:54,d:18,hr:12,sb:12,k:112,r:44,rbi:38,tb:144,epa:3.9},
     {n:8,name:"Kevin McGonigle",b:"R",pos:"SS",g:42,pa:152,h:38,s:22,d:10,hr:4,sb:4,k:42,r:20,rbi:18,tb:62,epa:3.8},
     {n:9,name:"Kerry Carpenter",b:"L",pos:"DH",g:108,pa:378,h:88,s:54,d:18,hr:14,sb:4,k:104,r:46,rbi:48,tb:148,epa:3.7},
   ],
   hb:[
     {n:1,name:"Fernando Tatis Jr.",b:"R",pos:"RF",g:148,pa:561,h:148,s:84,d:28,hr:32,sb:24,k:148,r:98,rbi:92,tb:280,epa:4.8},
     {n:2,name:"Xander Bogaerts",b:"R",pos:"SS",g:138,pa:518,h:134,s:82,d:30,hr:20,sb:4,k:102,r:72,rbi:72,tb:228,epa:4.6},
     {n:3,name:"Manny Machado",b:"R",pos:"3B",g:141,pa:528,h:134,s:76,d:28,hr:26,sb:4,k:98,r:72,rbi:82,tb:242,epa:4.4},
     {n:4,name:"Jackson Merrill",b:"L",pos:"CF",g:148,pa:551,h:142,s:88,d:30,hr:20,sb:16,k:118,r:72,rbi:68,tb:240,epa:4.3},
     {n:5,name:"Miguel Andujar",b:"R",pos:"DH",g:114,pa:404,h:96,s:60,d:18,hr:14,sb:2,k:108,r:48,rbi:52,tb:156,epa:4.1},
     {n:6,name:"Gavin Sheets",b:"L",pos:"1B",g:118,pa:421,h:98,s:60,d:20,hr:16,sb:2,k:118,r:48,rbi:56,tb:166,epa:4.0},
     {n:7,name:"Freddy Fermin",b:"R",pos:"C",g:101,pa:354,h:82,s:52,d:16,hr:8,sb:2,k:72,r:36,rbi:36,tb:122,epa:3.9},
     {n:8,name:"Ha-Seong Kim",b:"R",pos:"2B",g:131,pa:471,h:111,s:68,d:24,hr:14,sb:16,k:102,r:58,rbi:54,tb:183,epa:3.8},
     {n:9,name:"Jake Cronenworth",b:"L",pos:"LF",g:138,pa:511,h:122,s:74,d:26,hr:20,sb:4,k:102,r:62,rbi:68,tb:212,epa:3.7},
   ]},
  {id:"cle-sea",time:"9:40 PM ET",tv:"MLB.TV",marquee:true,away:"CLE",home:"SEA",venue:"T-Mobile Park",
   ap:{name:"Tanner Bibee",hand:"R",tier:"B",era:3.58,fip:3.74,whip:1.18,kp:27.4,gb:44.8,projK:5.8,projO:15,projH:4.8,projER:2.1,projBB:3,note:"7K/5IP yesterday. Likely short today on pitch count."},
   hp:{name:"George Kirby",hand:"R",tier:"A",era:3.12,fip:3.04,whip:1.02,kp:31.2,gb:42.8,projK:7.7,projO:18,projH:3.8,projER:1.5,projBB:2,note:"SEA elite. 31.2% K%, best command in AL. T-Mobile SO+4%."},
   // CLE confirmed OD lineup
   ab:[
     {n:1,name:"Steven Kwan",b:"L",pos:"LF",g:148,pa:561,h:162,s:110,d:30,hr:18,sb:22,k:64,r:94,rbi:68,tb:254,epa:4.8},
     {n:2,name:"Chase DeLauter",b:"L",pos:"RF",g:131,pa:488,h:122,s:74,d:26,hr:19,sb:16,k:118,r:68,rbi:64,tb:211,epa:4.6},
     {n:3,name:"José Ramírez",b:"S",pos:"3B",g:152,pa:591,h:162,s:86,d:36,hr:32,sb:24,k:94,r:98,rbi:108,tb:302,epa:4.4},
     {n:4,name:"Kyle Manzardo",b:"L",pos:"DH",g:114,pa:404,h:94,s:56,d:20,hr:16,sb:2,k:112,r:48,rbi:54,tb:162,epa:4.3},
     {n:5,name:"Bo Naylor",b:"S",pos:"C",g:114,pa:404,h:88,s:54,d:18,hr:14,sb:4,k:118,r:44,rbi:48,tb:148,epa:4.1},
     {n:6,name:"Rhys Hoskins",b:"R",pos:"1B",g:131,pa:481,h:111,s:62,d:24,hr:22,sb:2,k:128,r:58,rbi:66,tb:201,epa:4.0},
     {n:7,name:"Daniel Schneemann",b:"R",pos:"CF",g:88,pa:308,h:72,s:46,d:14,hr:6,sb:8,k:72,r:38,rbi:30,tb:104,epa:3.9},
     {n:8,name:"Gabriel Arias",b:"R",pos:"SS",g:101,pa:358,h:82,s:52,d:16,hr:8,sb:6,k:98,r:38,rbi:36,tb:122,epa:3.8},
     {n:9,name:"Brayan Rocchio",b:"S",pos:"2B",g:114,pa:404,h:94,s:60,d:18,hr:10,sb:14,k:98,r:48,rbi:40,tb:148,epa:3.7},
   ],
   // SEA confirmed OD lineup (Donovan leads off)
   hb:[
     {n:1,name:"Brendan Donovan",b:"L",pos:"3B",g:131,pa:481,h:118,s:76,d:24,hr:12,sb:8,k:88,r:62,rbi:52,tb:178,epa:4.8},
     {n:2,name:"Cal Raleigh",b:"S",pos:"C",g:148,pa:551,h:138,s:70,d:28,hr:39,sb:2,k:148,r:84,rbi:98,tb:285,epa:4.6},
     {n:3,name:"Julio Rodríguez",b:"R",pos:"CF",g:148,pa:568,h:152,s:88,d:32,hr:28,sb:32,k:148,r:94,rbi:82,tb:276,epa:4.4},
     {n:4,name:"Josh Naylor",b:"L",pos:"1B",g:141,pa:521,h:131,s:76,d:28,hr:25,sb:4,k:118,r:68,rbi:82,tb:238,epa:4.3},
     {n:5,name:"Randy Arozarena",b:"R",pos:"LF",g:138,pa:511,h:121,s:72,d:26,hr:18,sb:28,k:138,r:68,rbi:62,tb:201,epa:4.1},
     {n:6,name:"Luke Raley",b:"L",pos:"RF",g:118,pa:424,h:96,s:60,d:20,hr:14,sb:12,k:118,r:52,rbi:50,tb:158,epa:4.0},
     {n:7,name:"Dominic Canzone",b:"L",pos:"DH",g:121,pa:441,h:104,s:64,d:22,hr:16,sb:6,k:114,r:54,rbi:54,tb:178,epa:3.9},
     {n:8,name:"Cole Young",b:"L",pos:"2B",g:64,pa:224,h:52,s:34,d:10,hr:4,sb:8,k:54,r:28,rbi:20,tb:74,epa:3.8},
     {n:9,name:"Leo Rivas",b:"R",pos:"SS",g:52,pa:182,h:42,s:28,d:8,hr:2,sb:6,k:48,r:22,rbi:16,tb:56,epa:3.7},
   ]},
  {id:"ari-lad",time:"10:10 PM ET",tv:"MLB.TV",marquee:true,away:"ARI",home:"LAD",venue:"Uniqlo Field",
   ap:{name:"Merrill Kelly",hand:"R",tier:"B",era:3.68,fip:3.82,whip:1.18,kp:24.8,gb:46.2,projK:5.4,projO:16,projH:4.6,projER:2.2,projBB:3,note:"ARI veteran. Returns from elbow. Uniqlo HR+8%."},
   hp:{name:"Roki Sasaki",hand:"R",tier:"B+",era:3.48,fip:3.62,whip:1.14,kp:28.4,gb:44.8,projK:6.7,projO:17,projH:4.2,projER:2.0,projBB:3,note:"LAD. 100+ mph. Nasty split. Struggled spring but healthy."},
   // ARI confirmed lineup (Arenado signed)
   ab:[
     {n:1,name:"Geraldo Perdomo",b:"S",pos:"SS",g:138,pa:498,h:116,s:74,d:24,hr:10,sb:18,k:114,r:62,rbi:48,tb:178,epa:4.8},
     {n:2,name:"Ketel Marte",b:"S",pos:"2B",g:141,pa:528,h:148,s:86,d:32,hr:26,sb:8,k:108,r:84,rbi:82,tb:266,epa:4.6},
     {n:3,name:"Corbin Carroll",b:"L",pos:"RF",g:141,pa:528,h:138,s:86,d:28,hr:20,sb:34,k:128,r:86,rbi:62,tb:234,epa:4.4},
     {n:4,name:"Nolan Arenado",b:"R",pos:"3B",g:131,pa:481,h:118,s:66,d:24,hr:22,sb:2,k:104,r:62,rbi:72,tb:208,epa:4.3},
     {n:5,name:"Pavin Smith",b:"L",pos:"DH",g:101,pa:358,h:88,s:58,d:18,hr:10,sb:2,k:84,r:42,rbi:44,tb:136,epa:4.1},
     {n:6,name:"Gabriel Moreno",b:"R",pos:"C",g:118,pa:421,h:104,s:66,d:22,hr:12,sb:4,k:82,r:48,rbi:52,tb:166,epa:4.0},
     {n:7,name:"Carlos Santana",b:"S",pos:"1B",g:114,pa:404,h:88,s:52,d:18,hr:14,sb:1,k:96,r:44,rbi:48,tb:148,epa:3.9},
     {n:8,name:"Jordan Lawlar",b:"R",pos:"LF",g:88,pa:311,h:72,s:44,d:14,hr:8,sb:10,k:88,r:36,rbi:32,tb:110,epa:3.8},
     {n:9,name:"Alek Thomas",b:"L",pos:"CF",g:118,pa:421,h:101,s:64,d:22,hr:11,sb:10,k:98,r:52,rbi:44,tb:162,epa:3.7},
   ],
   // LAD confirmed lineup (Tucker added)
   hb:[
     {n:1,name:"Shohei Ohtani",b:"L",pos:"DH",g:158,pa:638,h:176,s:88,d:34,hr:52,sb:38,k:138,r:112,rbi:122,tb:370,epa:4.8},
     {n:2,name:"Kyle Tucker",b:"L",pos:"RF",g:148,pa:561,h:148,s:84,d:30,hr:30,sb:18,k:128,r:88,rbi:94,tb:268,epa:4.6},
     {n:3,name:"Mookie Betts",b:"R",pos:"SS",g:138,pa:528,h:142,s:82,d:32,hr:26,sb:18,k:102,r:88,rbi:82,tb:258,epa:4.4},
     {n:4,name:"Freddie Freeman",b:"L",pos:"1B",g:148,pa:568,h:162,s:92,d:38,hr:28,sb:8,k:112,r:92,rbi:98,tb:288,epa:4.3},
     {n:5,name:"Will Smith",b:"R",pos:"C",g:131,pa:491,h:122,s:68,d:26,hr:23,sb:4,k:98,r:68,rbi:74,tb:219,epa:4.1},
     {n:6,name:"Max Muncy",b:"L",pos:"3B",g:124,pa:451,h:104,s:54,d:22,hr:22,sb:2,k:124,r:58,rbi:64,tb:195,epa:4.0},
     {n:7,name:"Teoscar Hernández",b:"R",pos:"LF",g:141,pa:521,h:128,s:68,d:26,hr:28,sb:8,k:138,r:72,rbi:82,tb:242,epa:3.9},
     {n:8,name:"Andy Pages",b:"R",pos:"CF",g:114,pa:404,h:92,s:56,d:18,hr:16,sb:8,k:118,r:48,rbi:48,tb:160,epa:3.8},
     {n:9,name:"Miguel Rojas",b:"R",pos:"2B",g:118,pa:418,h:101,s:66,d:20,hr:8,sb:8,k:78,r:48,rbi:38,tb:149,epa:3.7},
   ]},
];

const FRAGS={"nyy-sf":["Yankees","Giants"],"laa-hou":["Angels","Astros"],"det-sd":["Tigers","Padres"],"cle-sea":["Guardians","Mariners"],"ari-lad":["Diamondbacks","Dodgers"]};

function parseInto(data,tgt){
  const seen=new Set(),priority=["draftkings","fanduel","betmgm","caesars","bovada"];
  const books=[...priority,...(data.bookmakers||[]).map(b=>b.key).filter(k=>!priority.includes(k))];
  for(const bk of books){
    const bm=(data.bookmakers||[]).find(b=>b.key===bk);
    if(!bm)continue;
    for(const mkt of(bm.markets||[])){
      const byP={};
      for(const o of(mkt.outcomes||[])){
        const d=(o.description||"").toLowerCase().replace(/\s+/g,"_");
        if(!byP[d])byP[d]={};
        if(o.name==="Over"){byP[d].ov=o.price;if(o.point!=null)byP[d].pt=o.point;}
        if(o.name==="Under")byP[d].uv=o.price;
      }
      for(const[desc,v]of Object.entries(byP)){
        if(v.pt==null)continue;
        const key=`${desc}_${mkt.key}`;
        if(!seen.has(key)){seen.add(key);tgt[key]={pt:v.pt,ov:v.ov||null,uv:v.uv||null,bk:bm.title};}
      }
    }
  }
}

const api=(path,params={})=>{
  const qs=new URLSearchParams({path,...params}).toString();
  return fetch(`/api/odds?${qs}`);
};

async function loadLines(setSt){
  const out={};for(const id of Object.keys(FRAGS))out[id]={};
  try{
    setSt("🔍 Fetching events...");
    const r=await api(`sports/${SPORT}/events`,{dateFormat:"iso"});
    if(!r.ok){const t=await r.text().catch(()=>"");throw new Error(`HTTP ${r.status}: ${t.slice(0,60)}`);}
    const evs=await r.json();
    if(!Array.isArray(evs)||!evs.length)throw new Error("No events returned");
    // Match hardcoded games
    const matched=[];
    for(const[sid,frags]of Object.entries(FRAGS)){
      const ev=evs.find(e=>frags.some(f=>(e.home_team||"").includes(f)||(e.away_team||"").includes(f)));
      if(ev)matched.push({sid,ev});
    }
    // Also discover any games NOT in FRAGS
    const matchedIds=new Set(matched.map(m=>m.ev.id));
    const seen=new Set();
    for(const ev of evs){
      if(matchedIds.has(ev.id))continue;
      const key=`${ev.away_team}@${ev.home_team}`;
      if(seen.has(key))continue;
      seen.add(key);
      // Only today's games (within ~30 hours)
      const diffH=(new Date(ev.commence_time)-new Date())/(1000*60*60);
      if(diffH>30||diffH<-6)continue;
      const sid=`extra-${ev.id.slice(0,8)}`;
      out[sid]={};
      matched.push({sid,ev,extra:true});
    }
    if(!matched.length)throw new Error(`No games found`);
    setSt(`📋 ${matched.length} games — fetching props...`);
    let tot=0;
    for(let i=0;i<matched.length;i++){
      const{sid,ev}=matched[i];
      setSt(`⏳ ${ev.away_team} @ ${ev.home_team}... (${i+1}/${matched.length})`);
      const[r1,r2]=await Promise.all([
        api(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:MKT1,oddsFormat:"american"}).catch(()=>null),
        api(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:MKT2,oddsFormat:"american"}).catch(()=>null),
      ]);
      if(r1?.ok)parseInto(await r1.json(),out[sid]);
      if(r2?.ok)parseInto(await r2.json(),out[sid]);
      tot+=Object.keys(out[sid]).length;
    }
    const live=Object.values(out).filter(g=>Object.keys(g).length>0).length;
    // Store extra games info for rendering
    out._extraGames=matched.filter(m=>m.extra).map(m=>({sid:m.sid,away:m.ev.away_team,home:m.ev.home_team,time:m.ev.commence_time}));
    setSt(live?`✅ ${tot} props across ${live}/${matched.length} games (DK priority)`:`⚠ ${matched.length} games found but no props posted yet`);
  }catch(e){setSt(`⚠ ${e.message}`);}
  return out;
}

function getL(lines,name,mkt){
  const p=name.toLowerCase().split(" "),last=p[p.length-1],first=p[0];
  for(const[k,v]of Object.entries(lines||{})){
    if(!k.endsWith(mkt))continue;
    if(k.includes(last)||k.includes(first))return v;
  }
  return null;
}

const mlP=ml=>ml<0?-ml/(-ml+100):100/(ml+100);
const dvig=(o,u)=>o&&u?mlP(o)/(mlP(o)+mlP(u)):null;
const toML=p=>!p?"—":p>=0.5?String(Math.round(-p/(1-p)*100)):"+"+Math.round((1-p)/p*100);
const eC=e=>e==null?C.muted:e>=1.5?C.green:e>=0.5?C.yellow:e<=-1.5?C.red:e<=-0.5?"#ff8a65":C.dim;

function proj(b,oppKp,oppHand,oppERA,pkHR,pkSO,pkRuns){
  const sc=b.epa/(b.pa/b.g);
  const kA=Math.max(0.72,1-((oppKp-22.8)*0.009));
  const eA=Math.max(0.85,1-((oppERA-4.50)*0.03));
  const plA=(b.b==="L"&&oppHand==="R")||(b.b==="R"&&oppHand==="L")||(b.b==="S")?1.04:0.96;
  const pkH=pkRuns/100*0.95;
  const adj=kA*eA*plA*pkH;
  const x=k=>b[k]/b.g*sc;
  const pH=+(x("h")*adj).toFixed(2);
  const pR=+(x("r")*adj).toFixed(2);
  const pI=+(x("rbi")*adj).toFixed(2);
  return{H:pH,HR:+(x("hr")*adj*(pkHR/100)).toFixed(2),R:pR,RBI:pI,
    TB:+(x("tb")*adj).toFixed(2),HRR:+(pH+pR+pI).toFixed(2),
    "2B":+(x("d")*adj).toFixed(2),SB:+(x("sb")).toFixed(2),
    K:+(x("k")/adj*(pkSO/100)).toFixed(2),"1B":+(x("s")*adj).toFixed(2)};
}

function OCell({pv,live,strong=0.28,lean=0.12}){
  const[line,setLine]=useState("");
  const lv=parseFloat(line)||live?.pt||null;
  const edge=lv!=null?+(pv-lv).toFixed(2):null;
  const fair=dvig(live?.ov,live?.uv);
  const vig=live?.ov&&live?.uv?+((mlP(live.ov)+mlP(live.uv)-1)*100).toFixed(1):null;
  const pick=edge==null?"":Math.abs(edge)>=strong?(edge>0?"O✅":"U✅"):Math.abs(edge)>=lean?(edge>0?"lO":"lU"):"—";
  const ec=eC(edge==null?null:Math.abs(edge)>=strong?(edge>0?2:-2):Math.abs(edge)>=lean?(edge>0?0.6:-0.6):0);
  const fmt=ml=>ml==null?"—":(ml>0?"+":"")+ml;
  return(
    <div>
      {live&&<div style={{marginBottom:2}}>
        <span style={{color:C.blue,fontFamily:"monospace",fontWeight:700,fontSize:11}}>{live.pt} </span>
        <span style={{color:live.ov>0?C.green:live.ov<-125?C.red:C.yellow,fontSize:9,fontWeight:700}}>{fmt(live.ov)}</span>
        <span style={{color:C.muted,fontSize:8}}>/</span>
        <span style={{color:live.uv>0?C.green:live.uv<-125?C.red:C.yellow,fontSize:9,fontWeight:700}}>{fmt(live.uv)}</span>
      </div>}
      <input type="number" step="0.5" value={line} onChange={e=>setLine(e.target.value)} placeholder={live?"ovr":"line"} style={II}/>
      {edge!=null&&<div style={{marginTop:2,color:ec,fontFamily:"monospace",fontWeight:700,fontSize:10}}>{edge>0?"+":""}{edge} {pick}</div>}
      {fair!=null&&<div style={{fontSize:7,color:C.dim}}>{(fair*100).toFixed(0)}% ({toML(fair)}) <span style={{color:vig<=4?C.green:vig<=7?C.yellow:C.red}}>{vig}%v</span></div>}
    </div>
  );
}

function PRow({p,lines,park}){
  const soF=(park?.so||100)/100,pf=park?.pf||1.0;
  const kAdj=+(p.projK*soF).toFixed(1),erAdj=+(p.projER*pf).toFixed(1);
  const kL=getL(lines,p.name,"pitcher_strikeouts"),oL=getL(lines,p.name,"pitcher_outs");
  const tc=TC[p.tier]||C.muted;
  return(
    <tr style={{borderBottom:`1px solid ${C.border}`}}>
      <td style={{padding:"8px 10px",minWidth:180,verticalAlign:"top"}}>
        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5,flexWrap:"wrap"}}>
          <span style={{background:p.hand==="L"?C.purple:C.blue,color:C.bg,fontSize:8,fontWeight:900,padding:"1px 4px",borderRadius:3}}>{p.hand}HP</span>
          <b style={{color:C.white,fontSize:12}}>{p.name}</b>
          <span style={{background:tc+"22",color:tc,fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:3}}>{p.tier}</span>
        </div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:4}}>
          {[[p.era+"ERA",p.era<=2.5?C.green:p.era<=3.2?C.yellow:C.red],[p.fip+"FIP",p.fip<=2.8?C.green:p.fip<=3.4?C.yellow:C.red],[p.whip+"W",p.whip<=1.0?C.green:p.whip<=1.2?C.yellow:C.red],[p.kp+"%K",p.kp>=30?C.green:p.kp>=26?C.yellow:C.dim],[p.gb+"%GB",p.gb>=50?C.green:C.dim]].map(([l,c])=>(
            <span key={l} style={{background:C.panel,borderRadius:3,padding:"1px 5px",color:c,fontFamily:"monospace",fontSize:9}}>{l}</span>
          ))}
        </div>
        <div style={{color:C.dim,fontSize:8,fontStyle:"italic",marginBottom:5}}>{p.note}</div>
        <div style={{display:"flex",gap:8}}>
          {[["H",p.projH,C.yellow],["ER",erAdj,C.orange],["BB",p.projBB,C.purple]].map(([l,v,c])=>(
            <div key={l} style={{textAlign:"center"}}>
              <div style={{color:C.muted,fontSize:7}}>PROJ {l}</div>
              <div style={{color:c,fontFamily:"monospace",fontWeight:700,fontSize:12}}>{v}</div>
            </div>
          ))}
        </div>
      </td>
      <td style={{padding:"8px 8px",borderLeft:`1px solid ${C.border}`,verticalAlign:"top"}}>
        <div style={{color:C.green,fontFamily:"monospace",fontWeight:900,fontSize:18,marginBottom:1}}>{kAdj}</div>
        <div style={{color:C.muted,fontSize:8,marginBottom:4}}>proj K (raw {p.projK})</div>
        <OCell pv={kAdj} live={kL} strong={1.0} lean={0.4}/>
      </td>
      <td style={{padding:"8px 8px",borderLeft:`1px solid ${C.border}`,verticalAlign:"top"}}>
        <div style={{color:C.blue,fontFamily:"monospace",fontWeight:900,fontSize:18,marginBottom:1}}>{p.projO}</div>
        <div style={{color:C.muted,fontSize:8,marginBottom:4}}>proj outs</div>
        <OCell pv={p.projO} live={oL} strong={1.0} lean={0.4}/>
      </td>
    </tr>
  );
}

function GameCard({g,lines}){
  const[open,setOpen]=useState(g.marquee||false);
  const[tab,setTab]=useState("p");
  const[visProps,setVP]=useState(["H","HR","HRR","TB"]);
  const park=PK[g.venue]||{so:100,HR:100,runs:100,pf:1.0};
  const gl=lines[g.id]||{};
  const hasL=Object.keys(gl).length>0;
  const topS=["S+","S","A"].includes(g.ap.tier)||["S+","S","A"].includes(g.hp.tier);
  const bC=topS?C.green:g.marquee?C.blue:C.border;
  const thS={padding:"5px 7px",color:C.muted,fontSize:8,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",background:"#0a0f1a",textAlign:"left"};

  const renderBats=(batters,oppP,oppHand)=>{
    const pkHR=park.HR||100,pkSO=park.so||100,pkRuns=park.runs||100;
    return(
      <div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:8}}>
          <span style={{color:C.muted,fontSize:9,alignSelf:"center",marginRight:4}}>PROPS:</span>
          {BPROPS.map(k=>(
            <button key={k} onClick={()=>setVP(p=>p.includes(k)?p.filter(x=>x!==k):[...p,k])}
              style={{background:visProps.includes(k)?BC[k]+"22":C.bg,color:visProps.includes(k)?BC[k]:C.muted,
                border:`1px solid ${visProps.includes(k)?BC[k]+"55":C.border}`,borderRadius:4,padding:"2px 8px",
                fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
              {k}
            </button>
          ))}
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
            <thead>
              <tr>
                <th style={thS}>BATTER</th>
                <th style={thS}>B</th>
                <th style={{...thS,color:C.blue}}>AVG</th>
                <th style={{...thS,color:C.red}}>HR</th>
                <th style={{...thS,color:C.blue}}>K%</th>
                {visProps.map(k=>(
                  <th key={k} style={{...thS,color:BC[k],borderLeft:`2px solid ${C.border}`,minWidth:110}}>
                    {k}<span style={{color:C.muted,fontWeight:400,fontSize:7}}> proj·line·edge</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batters.map(b=>{
                const pr=proj(b,oppP.kp,oppHand,oppP.era,pkHR,pkSO,pkRuns);
                const avg=(b.h/b.pa).toFixed(3);
                const kp=((b.k/b.pa)*100).toFixed(1);
                const plat=(b.b==="L"&&oppHand==="R")||(b.b==="R"&&oppHand==="L")||(b.b==="S");
                return(
                  <tr key={b.name} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:"5px 8px",whiteSpace:"nowrap"}}>
                      <b style={{color:C.white,fontSize:11}}>{b.n}. {b.name}</b>
                      <span style={{color:C.muted,fontSize:8,marginLeft:4}}>{b.pos}</span>
                    </td>
                    <td style={{padding:"5px 6px",color:plat?C.green:C.muted,fontWeight:700}}>{b.b}</td>
                    <td style={{padding:"5px 6px",color:parseFloat(avg)>=.285?C.green:C.yellow,fontFamily:"monospace"}}>{avg}</td>
                    <td style={{padding:"5px 6px",color:b.hr>=25?C.green:C.yellow,fontFamily:"monospace",fontWeight:700}}>{b.hr}</td>
                    <td style={{padding:"5px 6px",color:parseFloat(kp)<=18?C.green:parseFloat(kp)>=28?C.red:C.yellow,fontFamily:"monospace"}}>{kp}%</td>
                    {visProps.map(k=>{
                      const pv=pr[k],lv=getL(gl,b.name,BMKTS[k]);
                      const s=k==="HR"?0.10:k==="SB"||k==="2B"?0.08:0.25,l=k==="HR"?0.05:0.10;
                      return(
                        <td key={k} style={{padding:"5px 7px",borderLeft:`2px solid ${C.border}`,verticalAlign:"top"}}>
                          <div style={{color:BC[k],fontFamily:"monospace",fontWeight:700,fontSize:12,marginBottom:2}}>{pv}</div>
                          <OCell pv={pv} live={lv} strong={s} lean={l}/>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const tabBtn=(k,l)=>(
    <button onClick={e=>{e.stopPropagation();setTab(k);}} style={{
      padding:"4px 11px",border:"none",cursor:"pointer",fontWeight:700,fontSize:10,fontFamily:"monospace",
      borderRadius:"4px 4px 0 0",background:tab===k?C.green:C.panel,color:tab===k?C.bg:C.muted}}>
      {l}
    </button>
  );

  return(
    <div style={{borderRadius:12,border:`2px solid ${bC}44`,overflow:"hidden",marginBottom:10}}>
      <div onClick={()=>setOpen(o=>!o)} style={{background:C.panel,padding:"10px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
            {g.marquee&&<span style={{background:C.green,color:C.bg,fontSize:8,fontWeight:900,padding:"1px 6px",borderRadius:3}}>MARQUEE</span>}
            <span style={{color:C.white,fontWeight:700,fontSize:14}}>{g.away}<span style={{color:C.muted}}> @ </span>{g.home}</span>
            {hasL&&<span style={{background:C.green+"22",color:C.green,fontSize:8,padding:"1px 5px",borderRadius:3}}>LIVE✓</span>}
          </div>
          <div style={{color:C.muted,fontSize:9,marginTop:2}}>
            {g.time} · {g.tv} · {g.venue}
            <span style={{color:(park.runs||100)>=106?C.red:(park.runs||100)<=97?C.green:C.yellow,marginLeft:6,fontWeight:700}}>
              Runs:{park.runs||100} HR:{park.HR||100} SO:{park.so||100}
            </span>
          </div>
        </div>
        <div style={{display:"flex",gap:14}}>
          {[g.ap,g.hp].map(p=>{
            const tc=TC[p.tier]||C.muted;
            return(
              <div key={p.name} style={{textAlign:"center"}}>
                <div style={{color:tc,fontWeight:700,fontSize:10}}>{p.name.split(" ").pop()}</div>
                <div style={{color:C.muted,fontSize:8}}>{p.era} ERA · {p.tier}</div>
              </div>
            );
          })}
          <span style={{color:C.muted,fontSize:16,alignSelf:"center"}}>{open?"▲":"▼"}</span>
        </div>
      </div>
      {open&&(
        <div style={{background:C.card,padding:"10px 12px"}}>
          <div style={{display:"flex",gap:2,borderBottom:`1px solid ${C.border}`,marginBottom:10}}>
            {tabBtn("p","⚾ PITCHERS")}
            {tabBtn("ab",`🏟 ${g.away} BATS`)}
            {tabBtn("hb",`🏠 ${g.home} BATS`)}
          </div>
          {tab==="p"&&(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{background:"#0a0f1a"}}>
                  <th style={thS}>PITCHER · STATS · NOTE</th>
                  <th style={{...thS,color:C.green,minWidth:160}}>STRIKEOUTS proj/line O-U/edge</th>
                  <th style={{...thS,color:C.blue,minWidth:160}}>OUTS proj/line O-U/edge</th>
                </tr></thead>
                <tbody>
                  <PRow p={g.ap} lines={gl} park={park}/>
                  <PRow p={g.hp} lines={gl} park={park}/>
                </tbody>
              </table>
            </div>
          )}
          {tab==="ab"&&renderBats(g.ab,g.hp,g.hp.hand)}
          {tab==="hb"&&renderBats(g.hb,g.ap,g.ap.hand)}
        </div>
      )}
    </div>
  );
}

// ── Extra Game Card (discovered from API, no hardcoded projections) ──────
function ExtraGameCard({g,gl}){
  const[open,setOpen]=useState(false);
  const[tab,setTab]=useState("all");
  const[visProps,setVP]=useState(["H","HR","TB","HRR"]);
  const propCount=Object.keys(gl).length;
  const hasL=propCount>0;
  const t=new Date(g.time);
  const timeStr=t.toLocaleTimeString([],{hour:"numeric",minute:"2-digit",timeZoneName:"short"});

  // Extract player names from prop keys
  const pitchers=new Set(),batters=new Set();
  for(const key of Object.keys(gl)){
    const name=key.replace(/_(?:pitcher_|batter_)[^_]*$/,"").replace(/_/g," ");
    if(!name)continue;
    if(key.includes("pitcher_"))pitchers.add(name); else batters.add(name);
  }
  const pList=[...pitchers].sort(),bList=[...batters].sort();

  const tabBtn=(k,l)=>(
    <button onClick={e=>{e.stopPropagation();setTab(k);}} style={{
      padding:"4px 11px",border:"none",cursor:"pointer",fontWeight:700,fontSize:10,fontFamily:"monospace",
      borderRadius:"4px 4px 0 0",background:tab===k?C.green:C.panel,color:tab===k?C.bg:C.muted}}>
      {l}
    </button>
  );
  const thSx={padding:"5px 7px",color:C.muted,fontSize:8,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",background:"#0a0f1a",textAlign:"left"};
  const fmt=ml=>ml==null?"—":(ml>0?"+":"")+ml;

  return(
    <div style={{borderRadius:12,border:`2px solid ${hasL?C.blue:C.border}44`,overflow:"hidden",marginBottom:10}}>
      <div onClick={()=>setOpen(o=>!o)} style={{background:C.panel,padding:"10px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
            <span style={{color:C.white,fontWeight:700,fontSize:14}}>{g.away}<span style={{color:C.muted}}> @ </span>{g.home}</span>
            {hasL?<span style={{background:C.blue+"22",color:C.blue,fontSize:8,padding:"1px 5px",borderRadius:3}}>{propCount} PROPS</span>
                 :<span style={{background:C.yellow+"22",color:C.yellow,fontSize:8,padding:"1px 5px",borderRadius:3}}>NO PROPS YET</span>}
          </div>
          <div style={{color:C.muted,fontSize:10,marginTop:2}}>
            {timeStr}
            {pList.length>0&&<span style={{color:C.dim,marginLeft:8}}>SP: {pList.map(n=>n.split(" ").pop()).join(" vs ")}</span>}
          </div>
        </div>
        <span style={{color:C.muted,fontSize:16}}>{open?"▲":"▼"}</span>
      </div>
      {open&&hasL&&(
        <div style={{background:C.card,padding:"10px 12px"}}>
          <div style={{display:"flex",gap:2,borderBottom:`1px solid ${C.border}`,marginBottom:10}}>
            {tabBtn("all","📋 ALL PROPS")}
            {pList.length>0&&tabBtn("p","⚾ PITCHERS")}
            {bList.length>0&&tabBtn("b","🏏 BATTERS")}
          </div>
          {tab==="all"&&(
            <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                <thead><tr style={{background:"#0a0f1a"}}>
                  <th style={thSx}>PLAYER</th><th style={thSx}>PROP</th>
                  <th style={{...thSx,color:C.blue}}>LINE</th>
                  <th style={{...thSx,color:C.green}}>OVER</th>
                  <th style={{...thSx,color:C.red}}>UNDER</th>
                  <th style={{...thSx,color:C.yellow}}>FAIR</th>
                  <th style={thSx}>VIG</th>
                </tr></thead>
                <tbody>
                  {Object.entries(gl).sort((a,b)=>a[0].localeCompare(b[0])).map(([key,v])=>{
                    const parts=key.split(/_(?=pitcher_|batter_)/);
                    const name=(parts[0]||"").replace(/_/g," ");
                    const prop=(parts[1]||key.split("_").slice(-2).join("_")).replace(/_/g," ");
                    const fair=dvig(v.ov,v.uv);
                    const vig=v.ov&&v.uv?+((mlP(v.ov)+mlP(v.uv)-1)*100).toFixed(1):null;
                    return(
                      <tr key={key} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"4px 8px",color:C.white,fontWeight:600,textTransform:"capitalize"}}>{name}</td>
                        <td style={{padding:"4px 8px",color:C.dim,fontSize:9,textTransform:"capitalize"}}>{prop}</td>
                        <td style={{padding:"4px 8px",color:C.blue,fontFamily:"monospace",fontWeight:700}}>{v.pt}</td>
                        <td style={{padding:"4px 8px",color:v.ov>0?C.green:C.yellow,fontFamily:"monospace",fontWeight:700}}>{fmt(v.ov)}</td>
                        <td style={{padding:"4px 8px",color:v.uv>0?C.green:C.yellow,fontFamily:"monospace",fontWeight:700}}>{fmt(v.uv)}</td>
                        <td style={{padding:"4px 8px",color:C.green,fontFamily:"monospace"}}>{fair!=null?(fair*100).toFixed(0)+"%":"—"}</td>
                        <td style={{padding:"4px 8px",color:vig!=null?(vig<=4?C.green:vig<=7?C.yellow:C.red):C.muted,fontFamily:"monospace",fontSize:9}}>{vig!=null?vig+"%":"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {tab==="p"&&(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{background:"#0a0f1a"}}>
                  <th style={thSx}>PITCHER</th>
                  <th style={{...thSx,color:C.green,minWidth:140}}>STRIKEOUTS</th>
                  <th style={{...thSx,color:C.blue,minWidth:140}}>OUTS</th>
                </tr></thead>
                <tbody>
                  {pList.map(name=>{
                    const kL=getL(gl,name,"pitcher_strikeouts"),oL=getL(gl,name,"pitcher_outs");
                    return(
                      <tr key={name} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"8px 10px"}}><b style={{color:C.white,fontSize:13,textTransform:"capitalize"}}>{name}</b></td>
                        <td style={{padding:"8px",borderLeft:`1px solid ${C.border}`}}>
                          <OCell pv={null} live={kL} strong={1.0} lean={0.4}/>
                        </td>
                        <td style={{padding:"8px",borderLeft:`1px solid ${C.border}`}}>
                          <OCell pv={null} live={oL} strong={1.0} lean={0.4}/>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {tab==="b"&&(
            <div>
              <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:8}}>
                <span style={{color:C.muted,fontSize:9,alignSelf:"center",marginRight:4}}>PROPS:</span>
                {BPROPS.map(k=>(
                  <button key={k} onClick={()=>setVP(p=>p.includes(k)?p.filter(x=>x!==k):[...p,k])}
                    style={{background:visProps.includes(k)?BC[k]+"22":C.bg,color:visProps.includes(k)?BC[k]:C.muted,
                      border:`1px solid ${visProps.includes(k)?BC[k]+"55":C.border}`,borderRadius:4,padding:"2px 8px",
                      fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
                    {k}
                  </button>
                ))}
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                  <thead><tr>
                    <th style={thSx}>BATTER</th>
                    {visProps.map(k=>(
                      <th key={k} style={{...thSx,color:BC[k],borderLeft:`2px solid ${C.border}`,minWidth:120}}>
                        {k}<span style={{color:C.muted,fontWeight:400,fontSize:7}}> line·O/U·devig</span>
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {bList.map(name=>(
                      <tr key={name} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"5px 8px",whiteSpace:"nowrap"}}><b style={{color:C.white,fontSize:11,textTransform:"capitalize"}}>{name}</b></td>
                        {visProps.map(k=>{
                          const lv=getL(gl,name,BMKTS[k]);
                          return(
                            <td key={k} style={{padding:"5px 7px",borderLeft:`2px solid ${C.border}`,verticalAlign:"top"}}>
                              <OCell pv={null} live={lv} strong={k==="HR"?0.10:0.25} lean={k==="HR"?0.05:0.10}/>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
      {open&&!hasL&&(
        <div style={{background:C.card,padding:20,textAlign:"center",color:C.muted,fontSize:11}}>
          Props not posted yet — DK typically posts ~2-3 hrs before first pitch
        </div>
      )}
    </div>
  );
}

export default function App(){
  const[lines,setLines]=useState({});
  const[status,setStatus]=useState("Click ⚡ LOAD LIVE LINES to pull DK props");
  const[loading,setLoading]=useState(false);
  const[updated,setUpdated]=useState(null);

  const load=useCallback(async()=>{
    setLoading(true);
    const l=await loadLines(setStatus);
    setLines(l);setUpdated(new Date().toLocaleTimeString());setLoading(false);
  },[]);

  const elite=GAMES.flatMap(g=>[g.ap,g.hp]).filter(p=>["S+","S","A","B+"].includes(p.tier));

  return(
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:"'Courier New',monospace",color:C.white,padding:14}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12,gap:10,flexWrap:"wrap"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
            <div style={{background:C.green,color:C.bg,fontWeight:900,fontSize:10,padding:"2px 8px",borderRadius:3}}>MLB</div>
            <h1 style={{margin:0,fontSize:18,fontWeight:900}}>MARCH 27 2026</h1>
            <span style={{background:C.yellow+"33",color:C.yellow,fontSize:9,padding:"2px 7px",borderRadius:3,fontWeight:700}}>5 GAMES · CONFIRMED LINEUPS</span>
          </div>
          <div style={{color:C.muted,fontSize:10}}>
            Pitchers K·Outs·H·ER·BB · Batters H·HR·R·RBI·TB·HRR·2B·SB·K·1B · Live DK O/U odds + edge + devig
            {updated&&<span style={{color:C.green}}> · {updated}</span>}
          </div>
          <div style={{color:status.includes("⚠")?C.yellow:status.includes("✅")?C.green:C.dim,fontSize:9,marginTop:2}}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{background:loading?C.muted:C.green,color:C.bg,border:"none",borderRadius:7,padding:"10px 20px",fontWeight:900,fontSize:13,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0}}>
          {loading?"⟳ LOADING...":"⚡ LOAD LIVE LINES"}
        </button>
      </div>

      <div style={{background:C.panel,borderRadius:8,padding:"8px 12px",marginBottom:10,border:`1px solid ${C.green}33`}}>
        <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:5}}>⚡ WATCH LIST</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {elite.map(p=>{
            const g=GAMES.find(g=>g.ap===p||g.hp===p);
            const park=PK[g.venue]||{so:100};
            const kAdj=+(p.projK*(park.so||100)/100).toFixed(1);
            const tc=TC[p.tier]||C.yellow;
            return(
              <div key={p.name} style={{background:C.card,borderRadius:7,padding:"7px 11px",border:`1px solid ${tc}44`}}>
                <div style={{color:tc,fontWeight:700,fontSize:11}}>{p.name}</div>
                <div style={{color:C.muted,fontSize:8}}>{g.ap===p?g.away:g.home} · {g.time} · {p.tier}</div>
                <div style={{display:"flex",gap:10,marginTop:3}}>
                  <div><div style={{color:C.muted,fontSize:7}}>ERA</div><div style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{p.era}</div></div>
                  <div><div style={{color:C.muted,fontSize:7}}>PROJ K</div><div style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{kAdj}</div></div>
                  <div><div style={{color:C.muted,fontSize:7}}>K%</div><div style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{p.kp}%</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{background:"#0d1a0f",border:`1px solid ${C.green}44`,borderRadius:8,padding:"6px 12px",marginBottom:12,fontSize:9,color:C.dim}}>
        <b style={{color:C.green}}>📊 YESTERDAY RECAP: </b>
        <span style={{color:C.green}}>Crochet 8K/0ER ✅ · Sanchez 10K/0ER ✅ · Skubal 6K/0ER ✅ · Yamamoto 6K/2ER ✅ · Gilbert 7K ✅</span>
        <span style={{color:C.red}}> · Skenes 0.2IP blown up · Pivetta 3IP/6ER</span>
      </div>

      {GAMES.map(g=><GameCard key={g.id} g={g} lines={lines}/>)}

      {/* Extra games discovered from API but not in hardcoded slate */}
      {(lines._extraGames||[]).length>0&&(
        <div style={{marginTop:14}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,marginBottom:8,padding:"6px 12px",background:C.panel,borderRadius:6,border:`1px solid ${C.border}`}}>
            OTHER MLB GAMES — live props only (no projections)
          </div>
          {(lines._extraGames||[]).map(eg=>(
            <ExtraGameCard key={eg.sid} g={eg} gl={lines[eg.sid]||{}}/>
          ))}
        </div>
      )}

      <div style={{marginTop:12,color:C.muted,fontSize:8,textAlign:"center"}}>
        March 27 2026 · Lineups: MLB.com/RotoWire/ESPN confirmed · Stats: BR/FG/Savant 2025 · Park: Savant Statcast 3yr · Extra games auto-discovered
      </div>
    </div>
  );
}
