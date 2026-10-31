import {render,screen,waitFor} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {expect,it,vi} from "vitest";
import {Callback,googleSignIn,GOOGLE_VERIFIER_KEY} from "../src/AuthPages";
import {AuthStore} from "../src/auth";
import {AuthContext} from "../src/context";
import {json,session} from "./fixtures";

it("creates a browser-held proof and sends only its challenge to Google start",async()=>{
 const url=new URL(await googleSignIn("/"));
 const verifier=sessionStorage.getItem(GOOGLE_VERIFIER_KEY)!;
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)));
 const challenge=btoa(String.fromCharCode(...digest)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
 expect(url.searchParams.get("web_code_challenge")).toBe(challenge);
 expect(url.toString()).not.toContain(verifier);
});
it("rejects copied callbacks before exchanging a session",async()=>{
 window.history.replaceState(null,"","/auth/callback#handoff=copied");
 const auth=new AuthStore(localStorage,null);
 render(<MemoryRouter><AuthContext value={auth}><Callback/></AuthContext></MemoryRouter>);
 expect(await screen.findByRole("alert")).toHaveTextContent("Start Google sign-in in this browser");
 expect(fetch).not.toHaveBeenCalled();
 auth.dispose(); window.history.replaceState(null,"","/");
});
it("exchanges with the originating proof and removes it",async()=>{
 await googleSignIn("/"); const verifier=sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
 const fetcher=vi.fn(async (_url: string, _init?: RequestInit)=>json(session)); vi.stubGlobal("fetch",fetcher);
 window.history.replaceState(null,"","/auth/callback#handoff=valid");
 const auth=new AuthStore(localStorage,null);
 render(<MemoryRouter><AuthContext value={auth}><Callback/></AuthContext></MemoryRouter>);
 await waitFor(()=>expect(auth.getSnapshot().user).toEqual(session.user));
 expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({handoff:"valid",webCodeVerifier:verifier});
 expect(sessionStorage.getItem(GOOGLE_VERIFIER_KEY)).toBeNull();
 auth.dispose(); window.history.replaceState(null,"","/");
});
