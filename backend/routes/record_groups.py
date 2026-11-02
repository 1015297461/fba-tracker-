"""
查询记录分类 —— 两个模块共用的路由注册器。

为什么单独抽一个文件：类目榜单监控（`catmon`）和排名监测（`rank`）的分类逻辑
完全一样，只是数据源不同（前者是 `catmon_targets` 的行，后者是前端派生的
关键词记录）。复制两份迟早改漏，所以这里用 `scope` 参数化。

路由（`base` = `/api/catmon` 或 `/api/rank`）：
    GET    {base}/groups            → {groups, members}
    POST   {base}/groups            {name}
    PUT    {base}/groups            {id, name?, collapsed?}
    DELETE {base}/groups?id=xxx
    PUT    {base}/groups/order      {ids:[...]}           ← 分类本身排序
    PUT    {base}/items/group       {keys:[...], groupId} ← 批量归组（groupId=null 移出）
    PUT    {base}/items/order       {groupId, keys:[...]} ← 组内排序
"""

from urllib.parse import urlparse, parse_qs

GROUP_NAME_MAX = 20


def register_groups(scope, base, GET, POST, PUT, DELETE, state, verify):
    """把分类相关路由挂到指定的四张分发表上。

    verify(handler) -> bool：各模块自己的鉴权（已登录返回 True，未登录时已写回 401）。
    """

    def _payload(handler):
        data = handler._read_json()
        return data if isinstance(data, dict) else None

    def _dump(self):
        self._send_json(200, {"groups": state.list_record_groups(scope),
                              "members": state.list_record_members(scope)})

    # ---- 读：分组 + 成员归属 ----
    def get_groups(self):
        if not verify(self):
            return
        _dump(self)
    GET[base + "/groups"] = get_groups

    # ---- 新建 ----
    def post_groups(self):
        if not verify(self):
            return
        p = _payload(self)
        if p is None:
            return
        name = str(p.get("name") or "").strip()
        if not name:
            self._send_json(400, {"error": "分类名称不能为空"})
            return
        if len(name) > GROUP_NAME_MAX:
            self._send_json(400, {"error": f"分类名称最多 {GROUP_NAME_MAX} 字"})
            return
        state.create_record_group(scope, name)
        _dump(self)
    POST[base + "/groups"] = post_groups

    # ---- 改名 / 折叠 ----
    def put_groups(self):
        if not verify(self):
            return
        p = _payload(self)
        if p is None:
            return
        gid = str(p.get("id") or "").strip()
        if not gid:
            self._send_json(400, {"error": "id required"})
            return
        name = p.get("name")
        if name is not None:
            name = str(name).strip()
            if not name:
                self._send_json(400, {"error": "分类名称不能为空"})
                return
            if len(name) > GROUP_NAME_MAX:
                self._send_json(400, {"error": f"分类名称最多 {GROUP_NAME_MAX} 字"})
                return
        state.update_record_group(gid, {"name": name, "collapsed": p.get("collapsed")})
        _dump(self)
    PUT[base + "/groups"] = put_groups

    # ---- 删除（成员回「未分类」）----
    def delete_groups(self):
        if not verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        gid = (q.get("id") or [""])[0].strip()
        if not gid:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_record_group(gid)
        _dump(self)
    DELETE[base + "/groups"] = delete_groups

    # ---- 分类排序 ----
    def put_groups_order(self):
        if not verify(self):
            return
        p = _payload(self)
        if p is None:
            return
        ids = p.get("ids")
        if not isinstance(ids, list):
            self._send_json(400, {"error": "ids 需为数组"})
            return
        state.reorder_record_groups(scope, [str(x) for x in ids if x])
        _dump(self)
    PUT[base + "/groups/order"] = put_groups_order

    # ---- 批量归组 ----
    def put_items_group(self):
        if not verify(self):
            return
        p = _payload(self)
        if p is None:
            return
        keys = p.get("keys")
        if not isinstance(keys, list) or not keys:
            self._send_json(400, {"error": "keys 需为非空数组"})
            return
        gid = p.get("groupId") or None
        if gid is not None:
            gid = str(gid)
            # 分类必须属于同一个 scope，避免串模块
            if gid not in {g["id"] for g in state.list_record_groups(scope)}:
                self._send_json(404, {"error": "分类不存在"})
                return
        state.assign_record_members(scope, [str(k) for k in keys], gid)
        _dump(self)
    PUT[base + "/items/group"] = put_items_group

    # ---- 组内排序 ----
    def put_items_order(self):
        if not verify(self):
            return
        p = _payload(self)
        if p is None:
            return
        keys = p.get("keys")
        if not isinstance(keys, list):
            self._send_json(400, {"error": "keys 需为数组"})
            return
        gid = p.get("groupId") or None
        state.reorder_record_items(scope, str(gid) if gid else None, [str(k) for k in keys])
        _dump(self)
    PUT[base + "/items/order"] = put_items_order
