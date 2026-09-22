import { describe, expect, it } from "vitest";
import { currentCookieHeader, withRequestCookie, withSessionCredential } from "./request-cookie.js";

/** M2b-B2：模型鉴权凭据的解析优先级——ALS（Next 请求上下文）优先，
 *  会话级 credentialRef（Host 模式）回退；两者皆空为 null。 */
describe("credential 链（B2）", () => {
  it("ALS 优先于会话凭据；会话凭据在无 ALS 时生效；作用域结束还原", () => {
    expect(currentCookieHeader()).toBeNull();
    withSessionCredential("muzhi_session=host-cred", () => {
      expect(currentCookieHeader()).toBe("muzhi_session=host-cred");
      withRequestCookie("muzhi_session=als-cred", () => {
        expect(currentCookieHeader()).toBe("muzhi_session=als-cred");
      });
      expect(currentCookieHeader()).toBe("muzhi_session=host-cred");
    });
    expect(currentCookieHeader()).toBeNull();
  });

  it("嵌套作用域：内层无凭据时不继承外层旧值（请求间不串凭据）", () => {
    withSessionCredential("muzhi_session=a", () => {
      withSessionCredential(undefined, () => {
        expect(currentCookieHeader()).toBeNull();
      });
    });
  });
});
