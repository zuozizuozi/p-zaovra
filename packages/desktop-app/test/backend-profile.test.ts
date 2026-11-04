import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { createSidecarEnv, sidecarDirectory } from "../src/main/sidecar-env"

test("actual Core roots and SQLite state are empty in a fresh Beta and remain separate from dev/prod", async () => {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, "channel-backend-"))
  const script = `
    import { Global } from ${JSON.stringify(new URL("../../core/src/global.ts", import.meta.url).href)};
    import { Database } from ${JSON.stringify(new URL("../../core/src/database/database.ts", import.meta.url).href)};
    import { Database as SQLite } from "bun:sqlite";
    import { Credential } from ${JSON.stringify(new URL("../../core/src/credential.ts", import.meta.url).href)};
    import { LayerNode } from ${JSON.stringify(new URL("../../core/src/effect/layer-node.ts", import.meta.url).href)};
    import { Effect } from ${JSON.stringify(pathToFileURL(Bun.resolveSync("effect", import.meta.dir)).href)};
    const credentials=await Effect.runPromise(Effect.gen(function*(){
      const service=yield* Credential.Service;
      const before=yield* service.all();
      if(process.env.FIXTURE_WRITE)yield* service.create({integrationID:"fixture",value:Credential.Key.make({type:"key",key:"synthetic-only-584"})});
      return before.length;
    }).pipe(Effect.provide(LayerNode.compile(Credential.node))));
    const db=new SQLite(Database.path(),{create:true});
    db.run("CREATE TABLE IF NOT EXISTS fixture (kind TEXT, value TEXT)");
    const before=db.query("SELECT * FROM fixture").all();
    const config=await Bun.file(Global.Path.config+"/fixture-provider.json").text().catch(()=>null);
    if(process.env.FIXTURE_WRITE){db.run("INSERT INTO fixture VALUES ('session', ?), ('provider', ?)",[process.env.FIXTURE_WRITE,process.env.FIXTURE_WRITE]);await Bun.write(Global.Path.config+"/fixture-provider.json",process.env.FIXTURE_WRITE);}
    db.close();
    console.log(JSON.stringify({before,config,credentials,paths:Global.Path,db:Database.path(),cwd:process.cwd()}));
  `
  const run = async (channel: string, write?: string) => {
    await mkdir(sidecarDirectory(join(root, channel)), { recursive: true })
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: sidecarDirectory(join(root, channel)),
      env: {
        ...createSidecarEnv({
          env: process.env,
          platform: process.platform,
          packaged: true,
          channel,
          userDataPath: join(root, channel),
        }),
        ...(write ? { FIXTURE_WRITE: write } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, err).toBe(0)
    return JSON.parse(out.trim())
  }
  try {
    await run("dev", "synthetic-dev")
    await run("prod", "synthetic-prod")
    const beta = await run("beta")
    expect(beta.before).toEqual([])
    expect(beta.config).toBeNull()
    expect(beta.credentials).toBe(0)
    expect(beta.cwd).toBe(beta.paths.config)
    expect(beta.db).toStartWith(join(root, "beta", "data"))
    const dev = await run("dev")
    expect(dev.before.map((row: { value: string }) => row.value)).toEqual(["synthetic-dev", "synthetic-dev"])
    expect(dev.config).toBe("synthetic-dev")
    expect(dev.credentials).toBe(1)
  } finally {
    if (dirname(root) !== parent || !basename(root).startsWith("channel-backend-"))
      throw new Error("Refusing to remove a directory outside this fixture")
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
