package certificate

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

type Subject struct {
	CN string
	OU string
	O  string
	L  string
	S  string
	C  string
}
type Certificate struct {
	Thumbprint string
	Subject    Subject
}

func fetchCertificatesInWindows() ([]Certificate, error) {
	var certificates []Certificate

	// 必须从 LocalMachine\Root 获取证书（Chromium 内核要求必须在本地计算机存储）
	cmd := "Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object {$_.Subject -like '*SunnyNet*' -or $_.Subject -like '*Sunny*'}"
	ps := exec.Command("powershell.exe", "-Command", cmd)
	output, err := ps.CombinedOutput()
	if err == nil && len(output) > 0 {
		certificates = append(certificates, Certificate{
			Thumbprint: "SunnyNet",
			Subject: Subject{
				CN: "SunnyNet",
				O:  "SunnyNet",
			},
		})
	}

	return certificates, nil
}
func fetchCertificatesInMacOS() ([]Certificate, error) {
	cmd := exec.Command("security", "find-certificate", "-a")
	output, err2 := cmd.Output()
	if err2 != nil {
		return nil, errors.New(fmt.Sprintf("获取证书时发生错误，%v\n", err2.Error()))
	}
	var certificates []Certificate
	lines := strings.Split(string(output), "\n")
	for i := 0; i < len(lines)-1; i += 13 {
		if lines[i] == "" {
			continue
		}
		// if i > len(lines)-1 {
		// 	continue
		// }
		cenc := lines[i+5]
		ctyp := lines[i+6]
		hpky := lines[i+7]
		labl := lines[i+9]
		subj := lines[i+12]
		re := regexp.MustCompile(`="([^"]{1,})"`)
		// 找到匹配的字符串
		matches := re.FindStringSubmatch(labl)
		if len(matches) < 1 {
			continue
		}
		label := matches[1]
		certificates = append(certificates, Certificate{
			Thumbprint: "",
			Subject: Subject{
				CN: label,
				OU: cenc,
				O:  ctyp,
				L:  hpky,
				S:  subj,
				C:  cenc,
			},
		})
	}
	return certificates, nil
}

func fetchCertificates() ([]Certificate, error) {
	os_env := runtime.GOOS
	switch os_env {
	case "linux":
		fmt.Println("Running on Linux")
	case "darwin":
		return fetchCertificatesInMacOS()
	case "windows":
		return fetchCertificatesInWindows()
	default:
		fmt.Printf("Running on %s\n", os_env)
	}
	return nil, errors.New(fmt.Sprintf("unknown OS\n"))

}
func CheckCertificate(cert_name string) (bool, error) {
	certificates, err := fetchCertificates()
	if err != nil {
		return false, err
	}

	for _, cert := range certificates {
		// 精确匹配
		if cert.Subject.CN == cert_name {
			return true, nil
		}
		// 模糊匹配（包含关键字）
		if strings.Contains(cert.Subject.CN, cert_name) || strings.Contains(cert_name, cert.Subject.CN) {
			return true, nil
		}
		// 检查组织名称
		if cert.Subject.O == cert_name || strings.Contains(cert.Subject.O, cert_name) {
			return true, nil
		}
	}
	return false, nil
}
func removeCertificateInWindows(cert_name string) error {
	// 首先尝试从当前用户存储删除
	cmd := fmt.Sprintf("Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object {$_.Subject -like '*%s*'} | Remove-Item", cert_name)
	ps := exec.Command("powershell.exe", "-Command", cmd)
	output, err := ps.CombinedOutput()
	if err == nil {
		return nil // 成功从当前用户存储删除
	}

	// 如果当前用户存储删除失败，尝试从系统级存储删除
	cmd = fmt.Sprintf("Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object {$_.Subject -like '*%s*'} | Remove-Item", cert_name)
	ps = exec.Command("powershell.exe", "-Command", cmd)
	output, err = ps.CombinedOutput()
	if err != nil {
		return errors.New(fmt.Sprintf("删除证书时发生错误，%v\n", output))
	}
	return nil
}

func removeCertificateInMacOS(cert_name string) error {
	cmd := fmt.Sprintf("security delete-certificate -c '%s' /Library/Keychains/System.keychain", cert_name)
	ps := exec.Command("bash", "-c", cmd)
	output, err := ps.CombinedOutput()
	if err != nil {
		return errors.New(fmt.Sprintf("删除证书时发生错误，%v\n", output))
	}
	return nil
}

func RemoveCertificate(cert_name string) error {
	os_env := runtime.GOOS
	switch os_env {
	case "linux":
		return errors.New("Linux 系统暂不支持证书卸载功能")
	case "darwin":
		return removeCertificateInMacOS(cert_name)
	case "windows":
		return removeCertificateInWindows(cert_name)
	default:
		return errors.New(fmt.Sprintf("不支持的操作系统: %s\n", os_env))
	}
}
func installCertificateInWindows(cert_data []byte) error {
	cert_file, err := os.CreateTemp("", "SunnyRoot.cer")
	if err != nil {
		return errors.New(fmt.Sprintf("没有创建证书的权限，%v\n", err.Error()))
	}
	defer os.Remove(cert_file.Name())
	if _, err := cert_file.Write(cert_data); err != nil {
		return errors.New(fmt.Sprintf("获取证书失败，%v\n", err.Error()))
	}
	if err := cert_file.Close(); err != nil {
		return errors.New(fmt.Sprintf("生成证书失败，%v\n", err.Error()))
	}

	// 微信视频号 Chromium 内核必须要求证书安装在 LocalMachine\Root (本地计算机根证书)
	cmd := fmt.Sprintf("Import-Certificate -FilePath '%s' -CertStoreLocation Cert:\\LocalMachine\\Root", cert_file.Name())
	ps := exec.Command("powershell.exe", "-Command", cmd)
	output, err2 := ps.CombinedOutput()
	if err2 == nil {
		// 同时存入 CurrentUser 做双重保障
		_ = exec.Command("powershell.exe", "-Command", fmt.Sprintf("Import-Certificate -FilePath '%s' -CertStoreLocation Cert:\\CurrentUser\\Root", cert_file.Name())).Run()
		return nil
	}

	// 尝试 certutil 工具安装到本地计算机根证书
	cmdCertutil := fmt.Sprintf("certutil -addstore -f \"ROOT\" \"%s\"", cert_file.Name())
	outputCertutil, errCertutil := exec.Command("cmd.exe", "/c", cmdCertutil).CombinedOutput()
	if errCertutil == nil {
		_ = exec.Command("powershell.exe", "-Command", fmt.Sprintf("Import-Certificate -FilePath '%s' -CertStoreLocation Cert:\\CurrentUser\\Root", cert_file.Name())).Run()
		return nil
	}

	// 若系统级安装失败，回退到当前用户
	cmdUser := fmt.Sprintf("Import-Certificate -FilePath '%s' -CertStoreLocation Cert:\\CurrentUser\\Root", cert_file.Name())
	_ = exec.Command("powershell.exe", "-Command", cmdUser).Run()

	errorMsg := fmt.Sprintf("证书未能安装到【本地计算机】受信任的根证书颁发机构！\n\n原因：需要管理员权限写入 LocalMachine 根证书存储。\n错误详情：%v / %v\n\n解决方案：\n1. 请右键程序选择【以管理员身份运行】。\n2. 或者手动安装证书：\n   - 打开当前目录的 internal/assets/certs/SunnyRoot.cer\n   - 点击'安装证书' -> 选择'本地计算机' (切勿选当前用户) -> 选择'受信任的根证书颁发机构' -> 确定完成。", string(output), string(outputCertutil))
	return errors.New(errorMsg)
}
func installCertificateInMacOS(cert_data []byte) error {
	cert_file, err := os.CreateTemp("", "SunnyRoot.cer")
	if err != nil {
		return errors.New(fmt.Sprintf("没有创建证书的权限，%v\n", err.Error()))
	}
	defer os.Remove(cert_file.Name())
	if _, err := cert_file.Write(cert_data); err != nil {
		return errors.New(fmt.Sprintf("获取证书失败，%v\n", err.Error()))
	}
	if err := cert_file.Close(); err != nil {
		return errors.New(fmt.Sprintf("生成证书失败，%v\n", err.Error()))
	}
	cmd := fmt.Sprintf("security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '%s'", cert_file.Name())
	ps := exec.Command("bash", "-c", cmd)
	output, err2 := ps.CombinedOutput()
	if err2 != nil {
		return errors.New(fmt.Sprintf("安装证书时发生错误，%v\n", output))
	}
	return nil
}

func InstallCertificate(cert_data []byte) error {
	os_env := runtime.GOOS
	switch os_env {
	case "linux":
		fmt.Println("Running on Linux")
	case "darwin":
		return installCertificateInMacOS(cert_data)
	case "windows":
		return installCertificateInWindows(cert_data)
	default:
		fmt.Printf("Running on %s\n", os_env)
	}
	return errors.New(fmt.Sprintf("unknown OS\n"))
}
