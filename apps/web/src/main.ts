import { bootstrapApplication } from "@angular/platform-browser";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { provideRouter } from "@angular/router";
import { AppComponent } from "./app/app.component";
import { routes } from "./app/app.routes";
import { authInterceptor } from "./app/core/auth.interceptor";
import { timeToGrowCacheInterceptor } from "./app/core/time-to-grow-cache.interceptor";
bootstrapApplication(AppComponent,{providers:[provideHttpClient(withInterceptors([authInterceptor,timeToGrowCacheInterceptor])),provideRouter(routes)]}).catch(console.error);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

const preventManagementZoom = (event: Event) => {
  if (document.body.classList.contains("management-shell")) event.preventDefault();
};
for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(eventName, preventManagementZoom, { passive: false });
}
document.addEventListener("touchmove", (event) => {
  if (document.body.classList.contains("management-shell") && event.touches.length > 1) event.preventDefault();
}, { passive: false });
