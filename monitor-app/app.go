package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
	"pi-monitor/internal/service"
)

// pollEvery is the poll interval of spec R7, the same as the Bun monitor.
const pollEvery = 500 * time.Millisecond

// App is the Wails binding surface of spec R8. It holds no state of its own:
// the service builds the board and the repo Manager owns the repo list.
type App struct {
	ctx     context.Context
	manager *repos.Manager
	service *service.Service
}

// NewApp builds the shell state: the repo Manager from the --plans flags, the
// working folder and the saved repo list, and the service on top of it.
func NewApp() *App {
	manager := &repos.Manager{
		Flags: plansFlags(os.Args[1:]),
		Cwd:   workingDir(),
		Store: repos.Store{Path: reposFile()},
	}

	app := &App{manager: manager}
	manager.Pick = func() (string, error) {
		chosen, err := runtime.OpenDirectoryDialog(app.ctx, runtime.OpenDialogOptions{
			Title: "Choose a plans folder",
		})
		if err != nil {
			return "", err
		}
		return chosen, nil
	}

	app.service = service.New(service.Options{
		Repos: manager.Configs,
		Now:   func() int64 { return time.Now().UnixMilli() },
	})
	return app
}

// OnStartup stores the Wails context and starts the change poll.
func (a *App) OnStartup(ctx context.Context) {
	a.ctx = ctx
	go a.service.Poll(ctx, pollEvery, func() {
		runtime.EventsEmit(ctx, "change")
	})
}

// State returns the whole board for the configured repos.
func (a *App) State() model.MonitorState {
	return a.service.State()
}

// Session returns one page of a plan's session transcript.
func (a *App) Session(repo, plan, id string, after int) (model.SessionPage, error) {
	return a.service.Session(repo, plan, id, after)
}

// AddRepo asks for a plans folder and saves it. The returned text is the
// user-facing message, empty when the folder was added or the dialog was
// cancelled.
func (a *App) AddRepo() string {
	message, changed := a.manager.Add()
	if changed {
		runtime.EventsEmit(a.ctx, "change")
	}
	return message
}

// RemoveRepo deletes a saved repo by name. The returned text is the
// user-facing message, empty when the repo was removed.
func (a *App) RemoveRepo(name string) string {
	message, changed := a.manager.Remove(name)
	if changed {
		runtime.EventsEmit(a.ctx, "change")
	}
	return message
}

// plansFlags collects the values of every repeatable --plans flag, in the form
// --plans [name=]<path> or --plans=[name=]<path>.
func plansFlags(args []string) []string {
	out := make([]string, 0)
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--plans":
			if index+1 < len(args) {
				index++
				out = append(out, args[index])
			}
		case strings.HasPrefix(arg, "--plans="):
			if value := strings.TrimPrefix(arg, "--plans="); value != "" {
				out = append(out, value)
			}
		}
	}
	return out
}

// workingDir is the folder relative flags resolve against.
func workingDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}

// reposFile is the saved repo list under the user's config folder.
func reposFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".config", "pi-monitor", "repos.json")
	}
	return filepath.Join(home, ".config", "pi-monitor", "repos.json")
}
