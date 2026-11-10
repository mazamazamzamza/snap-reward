"use strict";
window.FrontLog = {
  send(data) { apiPost("/api/log", data).catch(() => {}); },
};
