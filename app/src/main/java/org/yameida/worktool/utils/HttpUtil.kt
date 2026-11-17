package org.yameida.worktool.utils

import com.blankj.utilcode.util.*
import com.lzy.okgo.OkGo
import com.lzy.okgo.callback.StringCallback
import com.lzy.okgo.model.Response
import org.json.JSONObject
import org.yameida.worktool.Constant
import org.yameida.worktool.service.log
import java.io.File

object HttpUtil {

    /**
     * 推送图片
     */
    fun pushImage(url: String, titleList: List<String>, receivedName: String?, imagePath: String, roomType: Int) {
        return pushImage(url, titleList, receivedName, File(imagePath).readBytes(), roomType)
    }

    /**
     * 推送图片
     */
    fun pushImage(url: String, titleList: List<String>, receivedName: String?, byteArray: ByteArray, roomType: Int) {
        val json = JSONObject()
        if (receivedName != null) {
            json.put("receivedName", receivedName)
            json.put("groupName", titleList.lastOrNull())
            if (titleList.size > 1) {
                json.put("groupRemark", titleList.first())
            } else {
                json.put("groupRemark", null)
            }
        } else {
            json.put("receivedName", titleList.lastOrNull { !it.contains("＠") } ?: "")
            json.put("groupName", null)
            json.put("groupRemark", null)
        }
        json.put("image", EncodeUtils.base64Encode2String(byteArray))
        json.put("robotId", Constant.robotId)
        json.put("roomType", roomType)
        json.put("atMe", false)
        json.put("textType", 2)
        OkGo.post<String>(url)
            .upJson(json)
            .execute(object : StringCallback() {
                override fun onSuccess(response: Response<String>) {
                    LogUtils.d("推送图片成功: ${titleList.joinToString()} $receivedName")
                    log("推送图片成功: ${titleList.joinToString()} $receivedName")
                }

                override fun onError(response: Response<String>) {
                    ToastUtils.showLong("推送图片失败")
                    LogUtils.e("推送图片失败")
                    error("推送图片失败: ${titleList.joinToString()} $receivedName")
                }
            })
    }

    /**
     * 推送本地文件
     */
    fun pushLocalFile(file: File) {
        OkGo.post<String>(Constant.getPushLocalFileUrl())
            .addFileParams("file", listOf(file))
            .execute(object : StringCallback() {
                override fun onSuccess(response: Response<String>?) {
                    LogUtils.d("推送本地文件成功: ${file.absolutePath}")
                }
            })
    }
}
