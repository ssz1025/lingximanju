// 最终产物域：导演包（zip）/ 成片（mp4）
import { json, assetFile, streamAsset } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { loadComfyConfig } from '../../core/comfy-config.mjs';
import { exportDirectorPack } from '../../core/director-pack.mjs';
import { emit } from '../../core/events.mjs';

export async function handleMedia(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // ---------- 两种最终产物：导演包 / 成片 ----------
  const deliverableMatch = pathname.match(MATCH.deliverable);
  if (deliverableMatch) {
    const [, id, kind] = deliverableMatch;
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const cfg = { ...loadComfyConfig(), ...(project.settings?.comfy || {}) };
    if (kind === 'director-pack') {
      if (method === 'POST') {
        const info = exportDirectorPack(project, cfg);
        const finalNode = project.nodes.find((n) => n.type === 'final');
        if (finalNode) {
          const pack = {
            url: info.url, file: info.file, filename: info.filename, bytes: info.bytes,
            shotCount: info.shotCount, fileCount: info.fileCount, target: info.format,
            groups: info.groups, note: info.note,
          };
          finalNode.data = { ...(finalNode.data || {}), directorPack: pack };
          saveProject(project);
          emit('node:data', { projectId: id, nodeId: finalNode.id, patch: { directorPack: pack } });
        }
        return json(res, info), true;
      }
      if (method === 'GET') {
        const existing = project.nodes.find((n) => n.type === 'final')?.data?.directorPack;
        const info = existing?.file && assetFile(existing.file) ? existing : exportDirectorPack(project, cfg);
        return streamAsset(res, info.file, info.filename, 'application/zip'), true;
      }
    }
    if (kind === 'film' && method === 'GET') {
      const film = project.nodes.find((n) => n.type === 'final')?.data?.film;
      if (!film?.file) return json(res, { error: '尚未生成成片，请先运行流水线并接入 ComfyUI 视频工作流' }, 404), true;
      return streamAsset(res, film.file, `lingximanju-${project.id}.mp4`, 'video/mp4'), true;
    }
  }

  return false;
}
