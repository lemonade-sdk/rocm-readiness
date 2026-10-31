"""Validate source configuration and project it into collector inputs."""

import copy
import re


def load_config(config):
    if not isinstance(config, dict):
        raise ValueError("configuration must be an object")
    if config.get("schema_version") == 1:
        if "projects" in config and "sources" not in config:
            if __package__:
                from .upstream import validate_projects
            else:
                from upstream import validate_projects
            validate_projects(config)
            return None, copy.deepcopy(config)
        # The legacy public input contains readiness feeds only.
        if __package__:
            from .collect import validate_config
        else:
            from collect import validate_config
        validate_config(config)
        return copy.deepcopy(config), None
    if config.get("schema_version") != 2:
        raise ValueError("unsupported sources schema_version")
    if __package__:
        from .collect import validate_config
        from .upstream import validate_projects
    else:
        from collect import validate_config
        from upstream import validate_projects

    projects = config.get("projects")
    sources = config.get("sources")
    views = config.get("views")
    if (
        not isinstance(projects, list)
        or not isinstance(sources, list)
        or not isinstance(views, dict)
    ):
        raise ValueError("projects, sources and views are required")
    project_map = {}
    for project in projects:
        if not isinstance(project, dict):
            raise ValueError("invalid project")
        pid = project.get("id")
        if (
            not isinstance(pid, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", pid)
            or pid in project_map
        ):
            raise ValueError("invalid or duplicate project id")
        project_map[pid] = project
    source_map = {}
    upstream_projects = set()
    readiness_sources = []
    upstream_sources = []
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("invalid source")
        sid = source.get("id")
        if (
            not isinstance(sid, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", sid)
            or sid in source_map
        ):
            raise ValueError("invalid or duplicate source id")
        if source.get("project") not in project_map:
            raise ValueError("unknown source project")
        kind = source.get("type")
        if kind == "readiness" and source.get("adapter") in {
            "qualification-v1",
            "lemonade-leaderboard-v1",
        }:
            readiness_sources.append(
                {
                    k: copy.deepcopy(v)
                    for k, v in source.items()
                    if k not in ("project", "type")
                }
            )
        elif kind == "upstream" and source.get("adapter") == "github-actions-v1":
            if source["project"] in upstream_projects:
                raise ValueError("duplicate upstream source for project")
            upstream_projects.add(source["project"])
            if not isinstance(source.get("jobs"), list):
                raise ValueError("upstream jobs must be a list")
            upstream_sources.append(source)
        else:
            raise ValueError("invalid source type or adapter")
        source_map[sid] = source
    readiness = {
        "schema_version": 1,
        "engines": copy.deepcopy(config["engines"]),
        "sources": readiness_sources,
    }
    if "reference_model" in config:
        readiness["reference_model"] = copy.deepcopy(config["reference_model"])
    validate_config(readiness)
    upview = views.get("upstream")
    # Validate every project and job, including entries outside a view.
    policy = (
        upview
        if isinstance(upview, dict)
        else {"window_days": 30, "client_rule": {"targets": ["gfx1151"]}}
    )
    all_projects = []
    for project in projects:
        projected = copy.deepcopy(project)
        source = next(
            (s for s in upstream_sources if s["project"] == project["id"]), None
        )
        projected["jobs"] = copy.deepcopy(source["jobs"]) if source else []
        all_projects.append(projected)
    if all_projects:
        validate_projects(
            {
                "schema_version": 1,
                "window_days": policy.get("window_days"),
                "client_rule": policy.get("client_rule"),
                "projects": all_projects,
            }
        )

    def selected(name):
        view = views.get(name)
        if view is None:
            return []
        if not isinstance(view, dict) or not isinstance(view.get("sources"), list):
            raise ValueError("invalid view")
        ids = view["sources"]
        if any(not isinstance(sid, str) or sid not in source_map for sid in ids) or len(
            ids
        ) != len(set(ids)):
            raise ValueError("unknown or duplicate view source")
        if any(source_map[sid]["type"] != name for sid in ids):
            raise ValueError("wrong source type for view")
        return ids

    if "readiness" not in views or views["readiness"] is None:
        raise ValueError("missing readiness view")
    rids = selected("readiness")
    uids = selected("upstream")
    by_readiness = {s["id"]: s for s in readiness_sources}
    readiness["sources"] = [by_readiness[sid] for sid in rids]
    if not uids:
        return readiness, None
    upstream = {
        "schema_version": 1,
        "window_days": upview["window_days"],
        "client_rule": copy.deepcopy(upview["client_rule"]),
        "projects": [],
    }
    for sid in uids:
        source = source_map[sid]
        project = copy.deepcopy(project_map[source["project"]])
        project["jobs"] = copy.deepcopy(source["jobs"])
        upstream["projects"].append(project)
    validate_projects(upstream)
    return readiness, upstream
