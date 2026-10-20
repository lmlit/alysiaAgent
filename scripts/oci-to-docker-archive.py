"""把 Docker 29 的 OCI tar 转成**经典 legacy docker-archive**（★ 2026-10-21）。

为什么需要：服务器 Docker 26.1.3 对 OCI 布局的 tar 走错分支（报
`docker-import-*/repositories: no such file or directory`）。
经典格式是"config json + layer_N.tar + manifest.json 指向它们"，
从 1.x 到 29 都认。

转换规则：
  1. 读 manifest.json（数组，取第一个）
  2. config blob → `<config-hex>.json`
  3. layer blobs → `layer_0.tar`, `layer_1.tar`, …（内容原样复制，层本身就是 gzip tar）
  4. 重写 manifest.json，路径**不带** blobs/ 前缀
  5. 输出 gzip 压缩的新 tar
"""
import json
import os
import sys
import tarfile

src = sys.argv[1]
dst = sys.argv[2]

with tarfile.open(src, "r") as tf:
    members = {m.name: m for m in tf.getmembers()}

    def read(name):
        f = tf.extractfile(name)
        if f is None:
            raise SystemExit(f"缺少成员: {name}")
        return f.read()

    manifest = json.loads(read("manifest.json").decode("utf-8"))
    if isinstance(manifest, dict):  # 万一是对象形式
        manifest = [manifest]
    entry = manifest[0]

    config_path = entry["Config"]
    layer_paths = entry["Layers"]
    repo_tags = entry.get("RepoTags") or ["server-alysia:latest"]

    config_hex = os.path.basename(config_path).split(".")[0]
    if config_hex.startswith("sha256:"):
        config_hex = config_hex[7:]
    config_name = f"{config_hex}.json"

    print(f"config: {config_path} -> {config_name}")
    print(f"layers: {len(layer_paths)} 层")

    with tarfile.open(dst, "w:gz") as out:
        # 1) config
        data = read(config_path)
        info = tarfile.TarInfo(config_name)
        info.size = len(data)
        import io
        out.addfile(info, io.BytesIO(data))

        # 2) layers
        new_layers = []
        for i, lp in enumerate(layer_paths):
            name = f"layer_{i}.tar"
            data = read(lp)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            out.addfile(info, io.BytesIO(data))
            new_layers.append(name)
            print(f"  layer_{i}: {lp[:24]}… {len(data)//1024}KB")

        # 3) manifest
        new_manifest = [
            {"Config": config_name, "RepoTags": repo_tags, "Layers": new_layers}
        ]
        mbytes = json.dumps(new_manifest).encode("utf-8")
        info = tarfile.TarInfo("manifest.json")
        info.size = len(mbytes)
        out.addfile(info, io.BytesIO(mbytes))

print(f"完成: {dst}  {os.path.getsize(dst)//1024//1024}MB")
