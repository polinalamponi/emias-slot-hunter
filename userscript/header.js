// userscript/header.js — метаданные; build.js вставляет их первыми
// Ключ inject-into = page нужен, чтобы и расширение Userscripts (Safari на iPhone)
// запускало скрипт внутри страницы ЕМИАС, как Tampermonkey при grant none.
// Tampermonkey этот ключ игнорирует. Строки комментариев здесь не должны
// начинаться с «// @» — build.js принял бы их за метаданные.
// ==UserScript==
// @name         ЕМИАС: охотник за слотами
// @namespace    https://github.com/polinalamponi/emias-slot-hunter
// @version      0.1.7.1
// @description  Следит за расписанием ЕМИАС и ловит освободившиеся слоты: записывает по направлению и переносит записи на более раннее время
// @author       polinalamponi
// @homepageURL  https://github.com/polinalamponi/emias-slot-hunter
// @supportURL   https://github.com/polinalamponi/emias-slot-hunter/issues
// @updateURL    https://raw.githubusercontent.com/polinalamponi/emias-slot-hunter/release/dist/emias-slot-hunter.user.js
// @downloadURL  https://raw.githubusercontent.com/polinalamponi/emias-slot-hunter/release/dist/emias-slot-hunter.user.js
// @match        https://emias.info/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==
